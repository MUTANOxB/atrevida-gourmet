import { HttpError } from "./errors.js";

export type DirectPixConfig = {
  pixKey: string;
  merchantName: string;
  merchantCity: string;
};

function field(id: string, value: string) {
  const length = Buffer.byteLength(value, "utf8");
  if (length > 99) throw new HttpError(422, "Dados do Pix excedem o limite permitido.");
  return `${id}${String(length).padStart(2, "0")}${value}`;
}

function sanitizeMerchant(value: string, maxLength: number, label: string) {
  const sanitized = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 $%*+\-./:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  if (!sanitized) throw new HttpError(422, `${label} do Pix não foi configurado.`);
  return sanitized;
}

function sanitizeTxid(value: string) {
  const sanitized = value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 25);
  return sanitized || "***";
}

export function pixCrc16(value: string) {
  let crc = 0xffff;
  for (const byte of Buffer.from(value, "utf8")) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

export function generatePixPayload(input: DirectPixConfig & {
  amountCents: number;
  txid: string;
}) {
  const pixKey = input.pixKey.trim();
  if (!pixKey || Buffer.byteLength(pixKey, "utf8") > 77) {
    throw new HttpError(422, "Chave Pix inválida ou não configurada.");
  }
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 0) {
    throw new HttpError(422, "Valor do Pix inválido.");
  }

  const merchantAccount = field("00", "BR.GOV.BCB.PIX") + field("01", pixKey);
  const payload = [
    field("00", "01"),
    field("26", merchantAccount),
    field("52", "0000"),
    field("53", "986"),
    field("54", (input.amountCents / 100).toFixed(2)),
    field("58", "BR"),
    field("59", sanitizeMerchant(input.merchantName, 25, "Nome do recebedor")),
    field("60", sanitizeMerchant(input.merchantCity, 15, "Cidade do recebedor")),
    field("62", field("05", sanitizeTxid(input.txid)))
  ].join("");
  const payloadWithCrcId = `${payload}6304`;
  return `${payloadWithCrcId}${pixCrc16(payloadWithCrcId)}`;
}

export function directPixConfigured(input: {
  pixKey?: string | null;
  pixMerchantName?: string | null;
  pixMerchantCity?: string | null;
}) {
  const key = input.pixKey?.trim() ?? "";
  if (!key || Buffer.byteLength(key, "utf8") > 77) return false;
  try {
    sanitizeMerchant(input.pixMerchantName ?? "", 25, "Nome do recebedor");
    sanitizeMerchant(input.pixMerchantCity ?? "", 15, "Cidade do recebedor");
    return true;
  } catch {
    return false;
  }
}
