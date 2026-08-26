// `dotenv/config`'s bare import loads `.env` by default, not
// `.env.test.local` — this setup file loads the right one explicitly so
// integration tests never accidentally read production-shaped defaults or
// silently no-op because .env.test.local was never picked up.
import { config } from "dotenv";
import path from "node:path";

config({ path: path.resolve(__dirname, "../../.env.test.local") });
