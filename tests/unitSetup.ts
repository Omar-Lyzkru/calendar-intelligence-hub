import { isolateProviderEnvironment } from "./providerEnvironment.js";
isolateProviderEnvironment();
// Unit tests must never fall back to a meaningful database from ignored configuration.
process.env.DATABASE_URL =
  "postgresql://synthetic@127.0.0.1:1/calendar_unit_test";
