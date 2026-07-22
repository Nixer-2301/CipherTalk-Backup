export function parseXmlDocument(content: string): XMLDocument {
  const xmlContent = content.includes('<msg>')
    ? content.substring(content.indexOf('<msg>'))
    : content
  return new DOMParser().parseFromString(xmlContent, 'text/xml')
}
