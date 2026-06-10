import fs from "node:fs";
import { Pool } from "pg";

function readEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};

  return Object.fromEntries(
    fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
      .map((line) => {
        const index = line.indexOf("=");
        let value = line.slice(index + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        return [line.slice(0, index), value];
      }),
  );
}

function normalizeDatabaseUrl(connectionString) {
  if (
    connectionString.includes("sslmode=require") &&
    !connectionString.includes("uselibpqcompat=")
  ) {
    return `${connectionString}${connectionString.includes("?") ? "&" : "?"}uselibpqcompat=true`;
  }

  return connectionString;
}

function connectionUrl(env, prefix) {
  return (
    process.env[`${prefix}_DATABASE_URL`] ??
    env.DATABASE_POSTGRES_URL_NON_POOLING ??
    env.DATABASE_POSTGRES_URL ??
    env.DATABASE_POSTGRES_PRISMA_URL ??
    env.DATABASE_URL
  );
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function qualified(table) {
  return `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
}

function tableKey(table) {
  return `${table.schema}.${table.name}`;
}

function envList(name) {
  const value = process.env[name];
  if (!value) return null;
  return new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => (item.includes(".") ? item : `public.${item}`)),
  );
}

async function publicTables(pool) {
  const result = await pool.query(`
    select schemaname as schema, tablename as name
    from pg_tables
    where schemaname = 'public'
    order by tablename
  `);
  return result.rows;
}

async function tableColumns(pool, table) {
  const result = await pool.query(
    `
      select column_name as name
      from information_schema.columns
      where table_schema = $1
        and table_name = $2
        and is_generated = 'NEVER'
      order by ordinal_position
    `,
    [table.schema, table.name],
  );
  return result.rows.map((row) => row.name);
}

async function primaryKeyColumns(pool, table) {
  const result = await pool.query(
    `
      select attr.attname as name
      from pg_index idx
      join pg_attribute attr
        on attr.attrelid = idx.indrelid
       and attr.attnum = any(idx.indkey)
      where idx.indrelid = ($1 || '.' || $2)::regclass
        and idx.indisprimary
      order by array_position(idx.indkey, attr.attnum)
    `,
    [table.schema, table.name],
  );
  return result.rows.map((row) => row.name);
}

async function dependencyOrder(pool, tables) {
  const tableKeys = new Set(tables.map(tableKey));
  const dependencies = new Map(tables.map((table) => [tableKey(table), new Set()]));
  const byKey = new Map(tables.map((table) => [tableKey(table), table]));

  const result = await pool.query(`
    select
      source_ns.nspname || '.' || source.relname as source_table,
      target_ns.nspname || '.' || target.relname as target_table
    from pg_constraint constraint_info
    join pg_class source on source.oid = constraint_info.conrelid
    join pg_namespace source_ns on source_ns.oid = source.relnamespace
    join pg_class target on target.oid = constraint_info.confrelid
    join pg_namespace target_ns on target_ns.oid = target.relnamespace
    where constraint_info.contype = 'f'
      and source_ns.nspname = 'public'
      and target_ns.nspname = 'public'
  `);

  for (const row of result.rows) {
    if (
      tableKeys.has(row.source_table) &&
      tableKeys.has(row.target_table) &&
      row.source_table !== row.target_table
    ) {
      dependencies.get(row.source_table)?.add(row.target_table);
    }
  }

  const ordered = [];
  const remaining = new Set(tableKeys);

  while (remaining.size) {
    const ready = [...remaining].filter((key) => {
      const deps = dependencies.get(key) ?? new Set();
      return [...deps].every((dependency) => !remaining.has(dependency));
    });

    if (!ready.length) {
      throw new Error(`Could not resolve table dependency order: ${[...remaining].join(", ")}`);
    }

    for (const key of ready.sort()) {
      ordered.push(byKey.get(key));
      remaining.delete(key);
    }
  }

  return ordered;
}

async function copyTable(source, target, table, sourceColumns, targetColumns) {
  const columns = sourceColumns.filter((column) => targetColumns.includes(column));
  if (!columns.length) {
    return 0;
  }

  const selectColumns = columns.map(quoteIdentifier).join(", ");
  const sourceRows = await source.query(`select ${selectColumns} from ${qualified(table)}`);
  let rowsToCopy = sourceRows.rows;

  if (process.env.SKIP_EXISTING === "1") {
    const primaryKey = await primaryKeyColumns(target, table);
    if (primaryKey.length && primaryKey.every((column) => columns.includes(column))) {
      const targetRows = await target.query(
        `select ${primaryKey.map(quoteIdentifier).join(", ")} from ${qualified(table)}`,
      );
      const existingKeys = new Set(
        targetRows.rows.map((row) => JSON.stringify(primaryKey.map((column) => row[column]))),
      );
      rowsToCopy = rowsToCopy.filter(
        (row) => !existingKeys.has(JSON.stringify(primaryKey.map((column) => row[column]))),
      );
    }
  }

  const configuredBatchSize = Number(process.env.BATCH_SIZE);
  const batchSize = Number.isFinite(configuredBatchSize) && configuredBatchSize > 0
    ? Math.floor(configuredBatchSize)
    : Math.max(1, Math.min(100, Math.floor(5000 / columns.length)));
  const conflictClause = process.env.ON_CONFLICT_DO_NOTHING === "1" ? " on conflict do nothing" : "";
  let copied = 0;

  for (let start = 0; start < rowsToCopy.length; start += batchSize) {
    const batch = rowsToCopy.slice(start, start + batchSize);
    const values = [];
    const rows = batch.map((row) => {
      const placeholders = columns.map((column) => {
        values.push(row[column]);
        return `$${values.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });

    const result = await target.query(
      `
        insert into ${qualified(table)} (${selectColumns})
        values ${rows.join(", ")}
        ${conflictClause}
      `,
      values,
    );
    copied += result.rowCount ?? 0;
    console.error(`copied ${tableKey(table)} batch ${Math.min(start + batch.length, rowsToCopy.length)}/${rowsToCopy.length}`);
  }

  return copied;
}

async function resetSequences(target, tables) {
  for (const table of tables) {
    const columns = await target.query(
      `
        select column_name as name
        from information_schema.columns
        where table_schema = $1
          and table_name = $2
          and column_default like 'nextval(%'
      `,
      [table.schema, table.name],
    );

    for (const column of columns.rows) {
      const sequence = await target.query("select pg_get_serial_sequence($1, $2) as name", [
        `${table.schema}.${table.name}`,
        column.name,
      ]);
      const sequenceName = sequence.rows[0]?.name;
      if (!sequenceName) continue;

      const maxValue = await target.query(
        `select coalesce(max(${quoteIdentifier(column.name)}), 0)::bigint as value from ${qualified(table)}`,
      );
      const value = Number(maxValue.rows[0]?.value ?? 0);
      await target.query("select setval($1::regclass, $2, $3)", [
        sequenceName,
        Math.max(value, 1),
        value > 0,
      ]);
    }
  }
}

async function tableCounts(pool, tables) {
  const counts = {};
  for (const table of tables) {
    const result = await pool.query(`select count(*)::int as count from ${qualified(table)}`);
    counts[tableKey(table)] = result.rows[0].count;
  }
  return counts;
}

const sourceEnv = {
  ...readEnvFile(process.env.SOURCE_ENV_FILE ?? "local.env"),
  ...process.env,
};
const targetEnv = {
  ...readEnvFile(process.env.TARGET_ENV_FILE),
  ...process.env,
};

const sourceUrl = connectionUrl(sourceEnv, "SOURCE");
const targetUrl = connectionUrl(targetEnv, "TARGET");

if (!sourceUrl || !targetUrl) {
  console.error("SOURCE_DATABASE_URL and TARGET_DATABASE_URL are required.");
  process.exit(1);
}

const source = new Pool({ connectionString: normalizeDatabaseUrl(sourceUrl) });
const target = new Pool({ connectionString: normalizeDatabaseUrl(targetUrl) });

try {
  const [sourceTables, targetTables] = await Promise.all([publicTables(source), publicTables(target)]);
  const targetKeys = new Set(targetTables.map(tableKey));
  const sourceKeys = new Set(sourceTables.map(tableKey));
  const commonTables = sourceTables.filter((table) => targetKeys.has(tableKey(table)));
  const requestedCopyTables = envList("COPY_TABLES");
  const requestedClearTables = envList("CLEAR_TABLES");
  const copyTables = commonTables.filter((table) => {
    const key = tableKey(table);
    return table.name !== "app_store" && (!requestedCopyTables || requestedCopyTables.has(key));
  });
  const clearTables = targetTables.filter((table) => {
    const key = tableKey(table);
    if (requestedClearTables) return requestedClearTables.has(key) && targetKeys.has(key);
    return sourceKeys.has(key);
  });
  const orderedTables = await dependencyOrder(source, copyTables);

  const sourceColumnMap = new Map();
  const targetColumnMap = new Map();
  for (const table of orderedTables) {
    sourceColumnMap.set(tableKey(table), await tableColumns(source, table));
    targetColumnMap.set(tableKey(table), await tableColumns(target, table));
  }

  async function runCopy() {
    if (clearTables.length) {
      await target.query(
        `truncate table ${clearTables.map(qualified).join(", ")} restart identity cascade`,
      );
    }

    const copied = {};
    for (const table of orderedTables) {
      copied[tableKey(table)] = await copyTable(
        source,
        target,
        table,
        sourceColumnMap.get(tableKey(table)),
        targetColumnMap.get(tableKey(table)),
      );
      console.error(`copied ${tableKey(table)}=${copied[tableKey(table)]}`);
    }

    await resetSequences(target, orderedTables);

    console.log(JSON.stringify({ copied, targetCounts: await tableCounts(target, orderedTables) }, null, 2));
  }

  if (process.env.NO_TRANSACTION === "1") {
    await runCopy();
  } else {
    await target.query("begin");
    try {
      await runCopy();
      await target.query("commit");
    } catch (error) {
      await target.query("rollback");
      throw error;
    }
  }
} finally {
  await Promise.allSettled([source.end(), target.end()]);
}
