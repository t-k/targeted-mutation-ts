export const eligibility = (age: number) => <button type="submit" aria-label="Continue" disabled={age < 18} />;
