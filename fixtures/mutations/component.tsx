import { useState } from 'react';

export function Field({ label, required = false }: { label: string; required?: boolean }) {
  const [value, setValue] = useState('');
  const invalid = required && value.trim() === '';
  return (
    <label className={invalid ? 'field invalid' : 'field'} data-kind="text">
      {label}: {required ? '*' : null}
      <input value={value} disabled={!label} onChange={event => setValue(event.target.value)} />
      {invalid && <span role="alert">{`Required: ${label}`}</span>}
    </label>
  );
}
