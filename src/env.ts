import { z } from 'zod';

const envSchema = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8788),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  VERSION: z.string().default('0.0.1'),
  AGENT_NAME: z.string().default('abzu-governance'),
  ADCP_AUTH_TOKEN: z.string().min(8),
  DEFAULT_MODE: z.enum(['audit', 'advisory', 'enforce']).default('advisory'),
  DATABASE_URL: z
    .string()
    .optional()
    .transform((s) => {
      const trimmed = s?.trim() ?? '';
      return trimmed.length > 0 ? trimmed : undefined;
    }),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}
