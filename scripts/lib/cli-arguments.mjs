export function parseCliArguments(argv, definitions) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const definition = definitions[argument];
    if (!definition) throw new Error(`CLI_ARGUMENT_UNKNOWN:${argument}`);
    if (definition.boolean) {
      parsed[definition.key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`CLI_ARGUMENT_VALUE_REQUIRED:${argument}`);
    }
    parsed[definition.key] = value;
    index += 1;
  }
  return parsed;
}

export function requireEnvironmentName(value, fallback) {
  const name = value || fallback;
  if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) throw new Error(`ENV_NAME_INVALID:${name}`);
  return name;
}
