import { defineConfig } from 'drizzle-kit'

const url =
  process.env.DATABASE_URL ??
  'postgres://bbs:bbs@127.0.0.1:5432/bbs'

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: false,
  verbose: true,
})
