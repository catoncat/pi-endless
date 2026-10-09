/** UI strings: English by default, Chinese when LANG/LC_ALL/MEM_LANG starts with zh. Model-facing prompts are always English (see core.ts). */
const zh = /^zh/i.test(process.env.MEM_LANG ?? process.env.LC_ALL ?? process.env.LANG ?? "");
export const t = (en: string, cn: string): string => (zh ? cn : en);
export const isZh = zh;
