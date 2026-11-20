export const saveButton = (saving: boolean, valid: boolean) =>
  <button type="submit" aria-label="Save" disabled={saving || !valid} />;
