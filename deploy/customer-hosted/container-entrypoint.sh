#!/bin/sh
set -eu

load_secret_file() {
  var_name="$1"
  file_var="${var_name}_FILE"
  eval "file_path=\${$file_var:-}"
  [ -z "$file_path" ] && return 0

  eval "current_value=\${$var_name:-}"
  if [ -n "$current_value" ]; then
    echo "Refusing to use both $var_name and $file_var" >&2
    exit 64
  fi
  if [ ! -r "$file_path" ]; then
    echo "Secret file for $var_name is not readable: $file_path" >&2
    exit 66
  fi

  value="$(cat "$file_path")"
  export "$var_name=$value"
}

for var_name in \
  B2_APPLICATION_KEY_ID \
  B2_APPLICATION_KEY \
  B2_MASTER_KEY_ID \
  B2_MASTER_KEY \
  B2_APP_KEY_ID \
  B2_APP_KEY
do
  load_secret_file "$var_name"
done

for file_var_name in $(env | sed -n 's/=.*//p' | grep -E '^B2_CREDENTIAL_[A-Z0-9_]+_(APPLICATION_KEY_ID|APPLICATION_KEY|MASTER_KEY_ID|MASTER_KEY|APP_KEY_ID|APP_KEY)_FILE$' || true)
do
  load_secret_file "${file_var_name%_FILE}"
done

exec b2-mcp-server "$@"
