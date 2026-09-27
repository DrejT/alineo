/**
 * Strict-TypeScript oxlint rules, vendored.
 *
 * Source: https://github.com/dmmulroy/anti-slop (MIT, see LICENSE). The upstream package is
 * `private: true` and unpublished, and its README's install path is to copy `src/` into the
 * consuming repo — so this is a vendored copy, not a dependency. Eight of upstream's eighteen
 * rules are kept; the plugin is renamed `strict-ts` here because the name appears in every
 * lint message. Re-apply the rename when syncing upstream changes.
 */
import { eslintCompatPlugin } from "@oxlint/plugins";

import { noReduceAccumulatorCopyRule } from "./rules/no-reduce-accumulator-copy.ts";
import { noChainedTypeAssertionsRule } from "./rules/no-chained-type-assertions.ts";
import { noModuleMockingRule } from "./rules/no-module-mocking.ts";
import { noReflectApplyRule } from "./rules/no-reflect-apply.ts";
import { noReflectGetRule } from "./rules/no-reflect-get.ts";
import { noUnknownTypeAliasesRule } from "./rules/no-unknown-type-aliases.ts";
import { noUnsafeDictionaryTypeRule } from "./rules/no-unsafe-dictionary-type.ts";
import { noWidenThenAssertRule } from "./rules/no-widen-then-assert.ts";

/** Generic Oxlint rules that reject low-evidence and low-signal implementation patterns. */
const antiSlopPlugin = eslintCompatPlugin({
	meta: { name: "strict-ts" },
	rules: {
		"no-reduce-accumulator-copy": noReduceAccumulatorCopyRule,
		"no-chained-type-assertions": noChainedTypeAssertionsRule,
		"no-module-mocking": noModuleMockingRule,
		"no-reflect-apply": noReflectApplyRule,
		"no-reflect-get": noReflectGetRule,
		"no-unsafe-dictionary-type": noUnsafeDictionaryTypeRule,
		"no-unknown-type-aliases": noUnknownTypeAliasesRule,
		"no-widen-then-assert": noWidenThenAssertRule,
	},
});

export default antiSlopPlugin;
