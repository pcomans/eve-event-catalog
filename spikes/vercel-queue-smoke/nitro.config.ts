import { defineConfig } from "nitro/config";

// Nitro v3's serverDir defaults to `false` (no auto directory scanning) —
// "./" turns on scanning routes/ and plugins/ at the project root, which is
// all this spike needs.
export default defineConfig({ serverDir: "./" });
