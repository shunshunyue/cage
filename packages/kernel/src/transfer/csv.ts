// CSV 是传输格式，不是一条新的写入通道：这里只拆分单元格、按命令输入类型转换，
// 必填、长度、业务约束仍由 worker 调用原命令时统一检查。
import { z } from 'zod';
import { cageError } from '../errors.js';

export const MAX_IMPORT_BYTES = 1_048_576;
export const MAX_IMPORT_ROWS = 1000;

export function csvCell(value: unknown): string {
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  // 表格软件会执行以这些字符开头的单元格。导出文件用于查看，不能把公式当作数据执行。
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function invalid(message: string): never { throw cageError('INVALID_INPUT', message); }

/** 接受 UTF-8 BOM、CRLF、引号内换行和双引号转义；拒绝歧义输入，不静默修正错列。 */
export function parseCsv(text: string): string[][] {
  if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) invalid('CSV 文件不能超过 1 MiB');
  text = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, closed = false;
  const endRow = () => {
    row.push(cell);
    if (row.length !== 1 || row[0] !== '') rows.push(row);
    if (rows.length > MAX_IMPORT_ROWS + 1) invalid(`一次最多导入 ${MAX_IMPORT_ROWS} 行`);
    row = []; cell = ''; closed = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else { quoted = false; closed = true; }
    } else if (ch === ',') { row.push(cell); cell = ''; closed = false; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else if (ch === '"' && !cell && !closed) quoted = true;
    else if (closed || ch === '"') invalid('CSV 引号格式错误');
    else cell += ch;
  }
  if (quoted) invalid('CSV 存在未闭合的引号');
  if (cell || row.length || closed) endRow();
  if (rows.length < 2) invalid('CSV 需要表头和至少一行数据');
  if (new Set(rows[0]).size !== rows[0].length || rows[0].some((v) => !v)) invalid('CSV 表头不能为空或重复');
  for (let i = 1; i < rows.length; i++) if (rows[i].length !== rows[0].length) invalid(`第 ${i + 1} 条 CSV 记录的列数与表头不一致`);
  return rows;
}

/** 只剥掉输入外壳；复杂联合类型保持字符串，由命令自己的 schema 给出校验结果。 */
function inner(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault) return inner(schema.unwrap() as z.ZodType);
  return schema;
}

export function importShape(schema: z.ZodType): Record<string, z.ZodType> {
  if (!(schema instanceof z.ZodObject)) invalid('CSV 导入要求命令使用 z.object 声明输入');
  return { ...schema.shape, expectedVersion: z.number().int().optional() };
}

export function csvInputs(text: string, schema: z.ZodType): Record<string, unknown>[] {
  const [headers, ...rows] = parseCsv(text);
  const shape = importShape(schema);
  for (const header of headers) if (!Object.hasOwn(shape, header)) invalid(`命令输入中没有字段 ${header}`);
  return rows.map((cells) => Object.fromEntries(headers.flatMap((header, index) => {
    const value = cells[index], field = shape[header], type = inner(field);
    // 空的可选列表示不提供，避免把“保持原值”误解释成“清空字段”。
    if (value === '' && field.isOptional()) return [];
    let parsed: unknown = value;
    if (type instanceof z.ZodNumber && value.trim() !== '') parsed = Number(value);
    else if (type instanceof z.ZodBoolean && ['true', 'false'].includes(value)) parsed = value === 'true';
    else if (type instanceof z.ZodArray || type instanceof z.ZodObject || type instanceof z.ZodRecord || (field.isNullable() && value === 'null')) {
      // JSON 错误保留原字符串，让该行在命令校验阶段失败，不丢掉其他正确行。
      try { parsed = JSON.parse(value); } catch { parsed = value; }
    }
    return [[header, parsed]];
  })));
}
