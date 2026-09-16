'use strict';

/**
 * 极简 .xlsx 生成器 —— 零依赖。
 *
 * .xlsx 本质是一个 ZIP，里面装着若干 XML。Node 自带 zlib，所以这里只需要
 * 自己写一个「不压缩」的 ZIP 打包器 + 几段 XML，不必引入 exceljs / xlsx 之类的库。
 *
 * 支持：多工作表、文本/数字两种单元格、首行加粗（表头）。
 * 不支持（用不上）：公式、图表、条件格式、合并单元格。
 */

/* ------------------------------- ZIP ------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** @param {Array<{name:string, data:Buffer}>} files */
function zipStore(files) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.data);
    const size = file.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flag: 文件名是 UTF-8
    local.writeUInt16LE(0, 8); // method 0 = 不压缩
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date = 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    parts.push(local, nameBuf, file.data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(SIG_CENTRAL, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + size;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, centralBuf, eocd]);
}

/* ------------------------------- XML ------------------------------- */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // XML 1.0 不允许这些控制字符，混进去会让 Excel 直接报文件损坏
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

/** 1 → A, 27 → AA */
function colLetter(n) {
  let s = '';
  let x = n;
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function sheetXml(rows) {
  const body = rows
    .map((row, r) => {
      const cells = row
        .map((val, c) => {
          if (val === null || val === undefined || val === '') return '';
          const ref = colLetter(c + 1) + (r + 1);
          const style = r === 0 ? ' s="1"' : '';
          if (typeof val === 'number' && Number.isFinite(val)) {
            return `<c r="${ref}"${style}><v>${val}</v></c>`;
          }
          return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${esc(val)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');

  return (
    XML_HEAD +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${body}</sheetData>` +
    '</worksheet>'
  );
}

const STYLES_XML =
  XML_HEAD +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2">' +
  '<font><sz val="11"/><name val="等线"/></font>' +
  '<font><b/><sz val="11"/><name val="等线"/></font>' +
  '</fonts>' +
  '<fills count="2">' +
  '<fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill>' +
  '</fills>' +
  '<borders count="1"><border/></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '</cellXfs>' +
  // 少了这一段，openpyxl 会报 "Workbook contains no default style"
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/**
 * @param {Array<{name: string, rows: Array<Array<string|number|null>>}>} sheets
 * @returns {Buffer} 完整的 .xlsx 文件内容
 */
function buildXlsx(sheets) {
  const rels = sheets
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
    )
    .join('');

  const sheetEntries = sheets.map((s, i) => ({
    name: `xl/worksheets/sheet${i + 1}.xml`,
    data: Buffer.from(sheetXml(s.rows), 'utf8'),
  }));

  const files = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        XML_HEAD +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          sheets
            .map(
              (_, i) =>
                `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
            )
            .join('') +
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
          '</Types>',
        'utf8'
      ),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        XML_HEAD +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>',
        'utf8'
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(
        XML_HEAD +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<sheets>' +
          sheets
            .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
            .join('') +
          '</sheets>' +
          '</workbook>',
        'utf8'
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(
        XML_HEAD +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          rels +
          `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
          '</Relationships>',
        'utf8'
      ),
    },
    ...sheetEntries,
    { name: 'xl/styles.xml', data: Buffer.from(STYLES_XML, 'utf8') },
  ];

  return zipStore(files);
}

module.exports = { buildXlsx, crc32, zipStore };
