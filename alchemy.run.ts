import alchemy from "alchemy";
import { ReactRouter } from "alchemy/cloudflare";
import { config } from "dotenv";

const app = await alchemy("alchemy-bun-monorepo-react-router");
const stage = app.stage;

config({ path: `./.env.${stage}` });

export const pro = await ReactRouter("pro", {
  cwd: "apps/pro",
  name: `${app.name}-site`,
  bindings: {
    VITE_ALCHEMY_STAGE: stage,
  },
  dev: {
    command: "bun run dev",
  },
  domains: [process.env.CUSTOM_WEB_DOMAIN || ""],
});

console.log(`Worker deployed at: ${pro.url}`);
await app.finalize();
