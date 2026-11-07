import { XMLParser } from 'fast-xml-parser';

export type XmlNode = Record<string, unknown>;

/** Parse XML into plain objects. Attributes are `@name`, text is `#text`.
 *  Elements listed in `arrays` always come back as arrays. fast-xml-parser
 *  never resolves external entities, so untrusted input can't read files. */
export function parseXml(text: string, arrays: string[]): XmlNode {
  const always = new Set(arrays);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    textNodeName: '#text',
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: false,
    cdataPropName: false,
    processEntities: true,
    isArray: name => always.has(name),
  });
  return parser.parse(text) as XmlNode;
}

export function attr(node: unknown, name: string): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const v = (node as XmlNode)[`@${name}`];
  return v === undefined || v === null ? undefined : String(v);
}

/** Text content of an element that may be a string or `{ '#text': … }`. */
export function text(node: unknown): string | undefined {
  if (node === undefined || node === null) return undefined;
  if (typeof node === 'string') return node;
  if (typeof node === 'object') {
    const t = (node as XmlNode)['#text'];
    if (t !== undefined) return String(t);
  }
  return undefined;
}

export function children(node: unknown, name: string): XmlNode[] {
  if (!node || typeof node !== 'object') return [];
  const v = (node as XmlNode)[name];
  if (v === undefined || v === null) return [];
  if (Array.isArray(v))
    return v.map(x => (typeof x === 'object' && x ? x : {})) as XmlNode[];
  return [typeof v === 'object' ? (v as XmlNode) : {}];
}

/** Parse seconds like `1.5`, `1,234.5` or `` into milliseconds. */
export function secondsToMs(v: string | undefined): number {
  if (!v) return 0;
  const n = Number.parseFloat(v.replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0;
}
