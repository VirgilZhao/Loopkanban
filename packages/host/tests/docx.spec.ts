import { describe, expect, it } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import { readZipFile, readZipIndex } from '../src/docs/zip.ts'
import { findAll, firstNamed, parseXml, textOf } from '../src/docs/xml.ts'
import { readDocx } from '../src/docs/docx.ts'
import { kindByName, type FileKind } from '../src/docs/kind.ts'
import { canInline, mimeOf } from '../src/attachments/index.ts'

/**
 * 造一个真的 ZIP。
 *
 * 不用固件文件是有意的：`.docx` 的读取路径要在**自己造的、结构可控的**
 * 输入上验证，才能针对性地把某一处弄坏（改压缩方式、砍掉中央目录）看它
 * 怎么反应 —— 一份二进制固件做不到这件事。
 *
 * CRC 一律写 0：读取路径不校验它（`inflateRaw` 自己也不校验），写个假的
 * 反而会让人以为这里在测校验。
 */
function zip(files: Record<string, string>, { store = false } = {}): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8')
    const body = store ? raw : deflateRawSync(raw)
    const nameBytes = Buffer.from(name, 'utf8')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(store ? 0 : 8, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, body)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(store ? 0 : 8, 10)
    entry.writeUInt32LE(body.length, 20)
    entry.writeUInt32LE(raw.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, nameBytes)

    offset += local.length + nameBytes.length + body.length
  }

  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

/** 把一串段落 XML 包成一份最小可用的 `word/document.xml`。 */
const document = (body: string): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
  + `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
  + `<w:body>${body}</w:body></w:document>`

/** 一个最简单的段落：一个 run，一段字。 */
const para = (text: string, props = ''): string =>
  `<w:p>${props}<w:r><w:t>${text}</w:t></w:r></w:p>`

describe('zip', () => {
  it('deflate 与原样存放两种都读得出来', () => {
    for (const store of [false, true]) {
      const bytes = zip({ 'a.txt': '你好，世界', 'b.txt': 'x'.repeat(5000) }, { store })
      expect(readZipFile(bytes, 'a.txt', 1_000_000)?.toString('utf8')).toBe('你好，世界')
      expect(readZipFile(bytes, 'b.txt', 1_000_000)?.length).toBe(5000)
    }
  })

  it('解压上限是硬的 —— 一个 zip bomb 不该换来一个 OOM', () => {
    // 一兆个零压完只有几百字节。上限设在它下面，就该被拒。
    const bytes = zip({ 'big.txt': '0'.repeat(1_000_000) })
    expect(readZipFile(bytes, 'big.txt', 1024)).toBeNull()
    expect(readZipFile(bytes, 'big.txt', 2_000_000)?.length).toBe(1_000_000)
  })

  it('不是 zip 就说不是，而不是解出半份垃圾', () => {
    expect(readZipIndex(Buffer.from('这不是个压缩包'))).toBeNull()
    expect(readZipIndex(Buffer.alloc(0))).toBeNull()
  })

  it('没有的条目回 null', () => {
    expect(readZipFile(zip({ 'a.txt': 'hi' }), 'b.txt', 1000)).toBeNull()
  })
})

describe('parseXml', () => {
  it('属性值里的 `>` 不会把标签切开', () => {
    const root = parseXml('<a><b w:val="x>y"/>尾</a>')
    expect(firstNamed(root as never, 'b')?.attrs['w:val']).toBe('x>y')
    expect(textOf(root as never)).toContain('尾')
  })

  it('实体、CDATA、注释各按各的规矩来', () => {
    const root = parseXml('<a><!--丢掉--><b>&#20320;&amp;&lt;</b><c><![CDATA[&amp; 原样]]></c></a>')
    expect(textOf(firstNamed(root as never, 'b') as never)).toBe('你&<')
    expect(textOf(firstNamed(root as never, 'c') as never)).toBe('&amp; 原样')
  })

  it('少一个闭标签也要把后面的内容读完 —— 半份文档比一句"打不开"有用', () => {
    const root = parseXml('<w:body><w:p><w:t>一</w:t><w:p><w:t>二</w:t></w:p></w:body>')
    expect(findAll(root as never, 'w:t').map(textOf)).toEqual(['一', '二'])
  })
})

describe('readDocx', () => {
  it('标题、段落、加粗、超链接：该分出来的都分出来', () => {
    const bytes = zip({
      'word/document.xml': document(
        para('设计说明', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>')
        + '<w:p><w:r><w:t>普通一句，</w:t></w:r>'
        + '<w:r><w:rPr><w:b/></w:rPr><w:t>加粗的</w:t></w:r>'
        // 显式关掉的加粗不算加粗 —— 从别处粘来的段落里这种到处都是。
        + '<w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>不加粗</w:t></w:r>'
        + '<w:hyperlink r:id="rId7"><w:r><w:t>文档</w:t></w:r></w:hyperlink></w:p>',
      ),
      'word/_rels/document.xml.rels':
        '<Relationships><Relationship Id="rId7" Target="https://example.com/a"/>'
        // javascript: 不该有第二条路进到页面的 href 里。
        + '<Relationship Id="rId8" Target="javascript:alert(1)"/></Relationships>',
    })

    const doc = readDocx(bytes)
    expect(doc).not.toBeNull()
    expect(doc?.blocks[0]).toMatchObject({ kind: 'heading', level: 1 })
    const body = doc?.blocks[1]
    expect(body?.kind).toBe('paragraph')
    if (body?.kind !== 'paragraph') return
    // 格式相同的相邻片段并成一个：Word 会把一句话拆成十几个 run。
    expect(body.spans.map((span) => span.text)).toEqual(['普通一句，', '加粗的', '不加粗', '文档'])
    expect(body.spans[1]?.bold).toBe(true)
    expect(body.spans[2]?.bold).toBeUndefined()
    expect(body.spans[3]?.href).toBe('https://example.com/a')
  })

  it('伪协议的链接一律不带出来', () => {
    const bytes = zip({
      'word/document.xml': document('<w:p><w:hyperlink r:id="rId9"><w:r><w:t>点我</w:t></w:r></w:hyperlink></w:p>'),
      'word/_rels/document.xml.rels':
        '<Relationships><Relationship Id="rId9" Target="javascript:alert(1)"/></Relationships>',
    })
    const block = readDocx(bytes)?.blocks[0]
    expect(block?.kind === 'paragraph' && block.spans[0]?.href).toBeUndefined()
  })

  it('编号列表分得清有序与圆点，且记着自己属于哪一份编号', () => {
    const list = (numId: string): string =>
      `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>`
      + `<w:r><w:t>第 ${numId} 号</w:t></w:r></w:p>`
    const bytes = zip({
      'word/document.xml': document(list('1') + list('2')),
      'word/numbering.xml':
        '<w:numbering>'
        + '<w:abstractNum w:abstractNumId="10"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>'
        + '<w:abstractNum w:abstractNumId="11"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>'
        + '<w:num w:numId="1"><w:abstractNumId w:val="10"/></w:num>'
        + '<w:num w:numId="2"><w:abstractNumId w:val="11"/></w:num>'
        + '</w:numbering>',
    })
    expect(readDocx(bytes)?.blocks).toMatchObject([
      { kind: 'list', ordered: true, numId: '1', level: 0 },
      { kind: 'list', ordered: false, numId: '2', level: 0 },
    ])
  })

  it('读不出编号定义就一律当圆点 —— 凭空造出的次序比不好看糟得多', () => {
    const bytes = zip({
      'word/document.xml': document(
        '<w:p><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>一条</w:t></w:r></w:p>',
      ),
    })
    expect(readDocx(bytes)?.blocks[0]).toMatchObject({ kind: 'list', ordered: false })
  })

  it('表格摊成行与单元格，单元格里的多段用换行接起来', () => {
    const bytes = zip({
      'word/document.xml': document(
        '<w:tbl><w:tr>'
        + `<w:tc>${para('姓名')}</w:tc>`
        + `<w:tc>${para('第一段')}${para('第二段')}</w:tc>`
        + '</w:tr></w:tbl>',
      ),
    })
    const block = readDocx(bytes)?.blocks[0]
    expect(block?.kind).toBe('table')
    if (block?.kind !== 'table') return
    expect(block.rows[0]?.[0]?.[0]?.text).toBe('姓名')
    expect(block.rows[0]?.[1]?.map((span) => span.text).join('')).toBe('第一段\n第二段')
  })

  it('制表与换行留住，被删掉的修订不留', () => {
    const bytes = zip({
      'word/document.xml': document(
        '<w:p><w:r><w:t>上</w:t><w:br/><w:t>下</w:t><w:tab/><w:t>右</w:t></w:r>'
        + '<w:del><w:r><w:delText>删掉的</w:delText></w:r></w:del>'
        + '<w:ins><w:r><w:t>加进来的</w:t></w:r></w:ins></w:p>',
      ),
    })
    const block = readDocx(bytes)?.blocks[0]
    expect(block?.kind === 'paragraph' && block.spans.map((s) => s.text).join('')).toBe('上\n下\t右加进来的')
  })

  it('空段落不占一个块 —— Word 文档里它们遍地都是', () => {
    const bytes = zip({ 'word/document.xml': document('<w:p/>' + para('唯一一句') + '<w:p><w:r><w:t>  </w:t></w:r></w:p>') })
    expect(readDocx(bytes)?.blocks).toHaveLength(1)
  })

  it('目录/封面裹在 w:sdt 里的段落也要读出来，不能悄悄丢掉', () => {
    // Word 的目录、封面、内容控件都在 body 那一层裹一个 w:sdt。整篇被裹住时
    // 只认直接孩子的话，给出来的是一份「空文档」—— 而它明明写满了字。
    const bytes = zip({
      'word/document.xml': document(
        `<w:sdt><w:sdtPr/><w:sdtContent>${para('第一章 概述')}${para('正文第一段。')}</w:sdtContent></w:sdt>`
        + para('外面的段落'),
      ),
    })
    expect(readDocx(bytes)?.blocks).toMatchObject([
      { kind: 'paragraph', spans: [{ text: '第一章 概述' }] },
      { kind: 'paragraph', spans: [{ text: '正文第一段。' }] },
      { kind: 'paragraph', spans: [{ text: '外面的段落' }] },
    ])
  })

  it('摊平只钻容器，不是见谁都往下走 —— 表格里的段落不能再数一遍', () => {
    const bytes = zip({
      'word/document.xml': document(`<w:tbl><w:tr><w:tc>${para('格子里')}</w:tc></w:tr></w:tbl>`),
    })
    // 一张表就是一个块。要是无差别递归，格子里那段会再冒出来一个顶层段落。
    expect(readDocx(bytes)?.blocks).toHaveLength(1)
    expect(readDocx(bytes)?.blocks[0]?.kind).toBe('table')
  })

  it('是个 zip 但不是 Word，就说读不出来，不给一份空文档', () => {
    expect(readDocx(zip({ 'xl/workbook.xml': '<workbook/>' }))).toBeNull()
    expect(readDocx(Buffer.from('随便什么字节'))).toBeNull()
  })
})

describe('kindByName', () => {
  it('按扩展名定呈现方式，认不出的交给内容去判', () => {
    expect(kindByName('方案.md')).toBe('markdown')
    expect(kindByName('/a/b/规格.PDF')).toBe('pdf')
    expect(kindByName('需求.docx')).toBe('docx')
    // 旧版 .doc 是二进制私有格式，不是 zip —— 认得它，但看不了。
    expect(kindByName('需求.doc')).toBe('binary')
    expect(kindByName('shot.png')).toBe('image')
    expect(kindByName('favicon.ico')).toBe('image')
    // svg 能跑脚本，故意不当图片放行。
    expect(kindByName('icon.svg')).toBeNull()
    expect(kindByName('Makefile')).toBeNull()
    expect(kindByName('main.ts')).toBeNull()
  })
})

/*
 * 呈现方式（`kindByName`）与 HTTP 类型（`mimeOf` / `canInline`）是**两份各自
 * 维护的清单**，而它们必须说同一件事：前端见到 `image` / `pdf` 就会去 raw 那个
 * 口子取字节，而那个口子只放行 `canInline` 认的类型。谁多一个后缀谁少一个，
 * 用户看到的就是一个没有任何提示的裂图。
 */
describe('kindByName 与 mimeOf 的清单要对得上', () => {
  const named = (kind: FileKind): string[] => [
    'a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', 'a.avif', 'a.bmp', 'a.ico', 'a.pdf',
    'a.md', 'a.ts', 'a.docx', 'a.doc', 'a.zip', 'a.svg',
  ].filter((name) => kindByName(name) === kind)

  it('凡是判成 image / pdf 的，raw 口子都得肯放它出去', () => {
    const inlineable = [...named('image'), ...named('pdf')]
    // 清单空了本身就是回归 —— 那说明上面那串后缀被谁改没了。
    expect(inlineable.length).toBeGreaterThan(5)
    for (const name of inlineable) {
      expect(canInline(mimeOf(name)), `${name} 判成了能看，raw 却不放行`).toBe(true)
    }
  })

  it('反过来，不判成 image / pdf 的一律不该被内联', () => {
    for (const name of ['a.md', 'a.ts', 'a.docx', 'a.doc', 'a.zip', 'a.svg']) {
      expect(canInline(mimeOf(name)), `${name} 不该能内联`).toBe(false)
    }
  })
})
