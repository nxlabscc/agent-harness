// Bun imports a `.sql` file as text with `with { type: "text" }`; this tells TypeScript.
declare module "*.sql" {
  const sql: string;
  export default sql;
}
