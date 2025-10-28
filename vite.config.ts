import { defineConfig } from "vite";

// If your site is served under https://<user>.github.io/swe-wod/,
// set base to "/swe-wod/". If you later move to the root domain
// (e.g., an org repo named swe-wod.github.io), change base to "/".
export default defineConfig({
  base: "/swe-wod/",
});
