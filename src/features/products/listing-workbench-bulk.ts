import { applyListingPatch, validateListingValues } from "@/features/products/listing-workbench-model";
import type {
  ListingBulkPasteRow,
  ListingDraftPatch,
  ListingDraftValues,
  ListingValidationErrors,
} from "@/shared/types/listing-workbench";

type PasteField = Exclude<keyof ListingDraftValues, "inventory">;

const fallbackFields: PasteField[] = ["sku", "title", "description", "tags"];

function normalizedHeader(value: string) {
  return value.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[\s_\-（）()]+/g, "");
}

function fieldFromHeader(value: string): PasteField | null {
  const header = normalizedHeader(value);
  const aliases: Array<[PasteField, string[]]> = [
    ["sku", ["sku", "skus", "itemsku", "货号", "商品编码"]],
    ["title", ["title", "listingtitle", "producttitle", "标题", "商品标题"]],
    ["description", ["description", "desc", "listingdescription", "描述", "商品描述"]],
    ["tags", ["tags", "tag", "keywords", "keyword", "标签", "关键词", "关键字"]],
    ["materials", ["materials", "material", "材料"]],
    ["price", ["price", "售价", "价格"]],
    ["quantity", ["quantity", "qty", "stock", "数量", "库存"]],
    ["taxonomyId", ["taxonomyid", "categoryid", "分类id", "类目id"]],
    ["shippingProfileId", ["shippingprofileid", "物流模板id", "运费模板id"]],
    ["readinessStateId", ["readinessstateid", "processingprofileid", "处理模板id", "备货模板id"]],
    ["returnPolicyId", ["returnpolicyid", "退货政策id"]],
    ["shopSectionId", ["shopsectionid", "店铺分组id"]],
    ["state", ["state", "publishstate", "status", "上架状态", "发布状态"]],
    ["whoMade", ["whomade", "制作者"]],
    ["whenMade", ["whenmade", "制作时间"]],
    ["type", ["type", "商品类型"]],
    ["isSupply", ["issupply", "供应品"]],
    ["shouldAutoRenew", ["shouldautorenew", "autorenew", "自动续期"]],
  ];
  return aliases.find(([, values]) => values.includes(header))?.[0] ?? null;
}

function listValue(value: string) {
  return value.split(/[,，;；\n]+/g).map((item) => item.trim()).filter(Boolean);
}

function booleanValue(value: string) {
  return ["1", "true", "yes", "y", "是", "启用"].includes(value.trim().toLowerCase());
}

function numericValue(value: string, field: string, errors: ListingValidationErrors, integer = true) {
  const normalized = value.replace(/[^\d.-]/g, "");
  const parsed = Number(normalized);
  if (!normalized || !Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) {
    errors[field] = integer ? "需要整数。" : "需要有效数字。";
    return null;
  }
  return parsed;
}

function changesFromCells(
  cells: string[],
  fields: Array<PasteField | null>,
  defaults: ListingDraftValues,
) {
  const changes: ListingDraftPatch = {};
  const errors: ListingValidationErrors = {};
  cells.forEach((rawValue, index) => {
    const field = fields[index];
    const value = rawValue?.trim() ?? "";
    if (!field || !value) return;
    if (field === "tags" || field === "materials") {
      changes[field] = listValue(value);
    } else if (field === "price") {
      const amount = numericValue(value, field, errors, false);
      changes.price = amount === null ? null : { amount, currency: defaults.price?.currency || "USD" };
    } else if (field === "quantity") {
      changes.quantity = numericValue(value, field, errors);
    } else if (["taxonomyId", "shippingProfileId", "readinessStateId", "returnPolicyId", "shopSectionId"].includes(field)) {
      const parsed = numericValue(value, field, errors);
      (changes as Record<string, unknown>)[field] = parsed && parsed > 0 ? parsed : null;
      if (parsed !== null && parsed <= 0) errors[field] = "ID 必须大于 0。";
    } else if (field === "isSupply" || field === "shouldAutoRenew") {
      changes[field] = booleanValue(value);
    } else if (field === "type") {
      changes.type = ["download", "digital", "数字", "数字商品"].includes(value.toLowerCase()) ? "download" : "physical";
    } else if (field === "state") {
      const normalized = value.toLowerCase();
      changes.state = ["active", "live", "上架", "发布"].includes(normalized)
        ? "active"
        : ["inactive", "下架"].includes(normalized)
          ? "inactive"
          : "draft";
    } else {
      (changes as Record<string, unknown>)[field] = value;
    }
  });
  return { changes, errors };
}

export function parseListingBulkPaste(table: string[][], defaults: ListingDraftValues): ListingBulkPasteRow[] {
  const nonEmpty = table.filter((row) => row.some((cell) => cell.trim()));
  if (!nonEmpty.length) return [];
  const detectedFields = nonEmpty[0].map(fieldFromHeader);
  const hasHeader = detectedFields.some(Boolean);
  const fields = hasHeader ? detectedFields : nonEmpty[0].map((_, index) => fallbackFields[index] ?? null);
  const sourceRows = hasHeader ? nonEmpty.slice(1) : nonEmpty;
  return sourceRows.slice(0, 100).flatMap((cells, index) => {
    const { changes, errors: parseErrors } = changesFromCells(cells, fields, defaults);
    const hasContent = [changes.sku, changes.title, changes.description, changes.tags]
      .some((item) => Array.isArray(item) ? item.length : String(item ?? "").trim());
    if (!hasContent) return [];
    const validationErrors = validateListingValues(applyListingPatch(defaults, changes), "new");
    return [{
      changes,
      errors: { ...validationErrors, ...parseErrors },
      rowNumber: index + (hasHeader ? 2 : 1),
    }];
  });
}
