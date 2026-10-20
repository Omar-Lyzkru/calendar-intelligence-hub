import { isolateProviderEnvironment } from "../providerEnvironment.js";
const testUrl = process.env.TEST_DATABASE_URL;
if (
  !testUrl ||
  testUrl === process.env.DATABASE_URL ||
  !new URL(testUrl).pathname.endsWith("_test")
)
  throw new Error(
    "TEST_DATABASE_URL must identify a separate database ending in _test",
  );
isolateProviderEnvironment();
process.env.DATABASE_URL = testUrl;
