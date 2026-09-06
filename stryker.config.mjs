const vitestConfig = process.env.STRYKER_VITEST_CONFIG ?? "vitest.config.ts"
const reportDirectory = process.env.STRYKER_REPORT_DIR ?? "reports/mutation"
const testFiles = JSON.parse(process.env.STRYKER_TEST_FILES ?? "[]")

export default {
	plugins: ["@stryker-mutator/vitest-runner"],
	testRunner: "vitest",
	vitest: {
		configFile: vitestConfig,
		related: process.env.STRYKER_VITEST_RELATED !== "false",
	},
	testFiles,
	incremental: false,
	// Stryker 10: module-scope code (e.g. the const error-message
	// declarations in core/checkpoints/rollback.ts) executes once when the
	// vitest runner's long-lived environment loads the module. On-the-fly
	// mutant activation cannot re-run it per mutant, so those mutants are
	// unobservable at test time (static: true, coveredBy: []) and would
	// always report "Survived" regardless of test quality. Report them as
	// Ignored instead. perTest coverage is required for ignoreStatic and is
	// the v10 default; set it explicitly to keep the pairing intentional.
	coverageAnalysis: "perTest",
	ignoreStatic: true,
	inPlace: process.env.STRYKER_IN_PLACE === "true",
	concurrency: 2,
	timeoutMS: 5_000,
	timeoutFactor: 1.5,
	cleanTempDir: "always",
	logLevel: "warn",
	reporters: ["json", "html"],
	jsonReporter: {
		fileName: `${reportDirectory}/mutation.json`,
	},
	htmlReporter: {
		fileName: `${reportDirectory}/mutation.html`,
	},
	thresholds: {
		high: 100,
		low: 100,
		break: null,
	},
}
