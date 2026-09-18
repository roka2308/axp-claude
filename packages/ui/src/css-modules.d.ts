/**
 * CSS Modules ship their class map as a default export. Declared here so the
 * design system typechecks without a bundler-specific plugin.
 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}

declare module '*.css';
