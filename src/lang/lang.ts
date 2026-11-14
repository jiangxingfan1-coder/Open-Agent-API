// OAA-Lang 的对外入口：实现按职责分在 lexer / suggest / parser / types / flow / statements /
// locate / compile / print / diagnose 里，这里只做再导出，外部一律从本文件引用。
export { type Token, tokenizeOaaLang, oaaSourceHasComments } from './lexer.js';
export { suggestName } from './suggest.js';
export { type CompiledOaaSource, compileOaaLang } from './compile.js';
export { decompileToOaaLang, formatOaaLang } from './print.js';
export { type OaaDiagnostic, type OaaDiagnosisReport, diagnoseOaaLang } from './diagnose.js';
