import english from "../locales/en.json";

export type TranslationKey = keyof typeof english;
type Message = string | { one: string; other: string };
type Resources = Partial<Record<TranslationKey, Message>>;
type Parameters = Record<string, string | number>;

export function createTranslator(locale = "en", resources: Resources = {}) {
  const plural = new Intl.PluralRules(locale);
  const numbers = new Intl.NumberFormat(locale);
  return (key: TranslationKey, params: Parameters = {}): string => {
    const resource = resources[key] ?? english[key];
    const text =
      typeof resource === "string"
        ? resource
        : typeof params.count === "number" &&
            plural.select(params.count) === "one"
          ? resource.one
          : resource.other;
    return text.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
      const value = params[name];
      return value === undefined
        ? placeholder
        : typeof value === "number"
          ? numbers.format(value)
          : value;
    });
  };
}

export const t = createTranslator();

export function describeError(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    const key = `error.${error.code}`;
    if (Object.prototype.hasOwnProperty.call(english, key)) {
      const parameters: Parameters = {};
      if (
        "parameters" in error &&
        typeof error.parameters === "object" &&
        error.parameters !== null
      ) {
        for (const [name, value] of Object.entries(error.parameters))
          if (typeof value === "string" || typeof value === "number")
            parameters[name] = value;
      }
      return t(key as TranslationKey, parameters);
    }
  }
  return t("error.operationFailed");
}
