import { a as cleanUpCheckout, n as reportInterrupted } from "./shared.js";
//#region src/post.ts
/* v8 ignore next */
reportInterrupted().finally(cleanUpCheckout);
//#endregion
export {};

//# sourceMappingURL=post.js.map