import { defineCloudflareConfig } from '@opennextjs/cloudflare';

// No incremental (ISR) cache binding: every page here is dynamic and per-user,
// and an R2-backed cache would need R2, which this project does not require.
export default defineCloudflareConfig({});
