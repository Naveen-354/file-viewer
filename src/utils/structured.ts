export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function parseStructured(text: string, extension: string | null): JsonValue {
  return extension === "xml" ? xmlToValue(text) : JSON.parse(text) as JsonValue;
}

function xmlToValue(text: string): JsonValue {
  const documentNode = new DOMParser().parseFromString(text, "application/xml");
  const parserError = documentNode.querySelector("parsererror");
  if (parserError) throw new Error(parserError.textContent?.trim() || "Invalid XML");
  const convert = (element: Element): JsonValue => {
    const result: Record<string, JsonValue> = {};
    for (const attribute of element.attributes) result[`@${attribute.name}`] = attribute.value;
    const children = [...element.children];
    if (!children.length) return element.textContent?.trim() ?? "";
    for (const child of children) {
      const item = convert(child);
      const prior = result[child.tagName];
      result[child.tagName] = prior === undefined ? item : Array.isArray(prior) ? [...prior, item] : [prior, item];
    }
    return result;
  };
  return { [documentNode.documentElement.tagName]: convert(documentNode.documentElement) };
}
