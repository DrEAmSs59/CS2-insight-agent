import { useCallback, useState } from "react";

export function useFieldValidation(rules = {}) {
  const [errors, setErrors] = useState({});

  const validate = useCallback(
    (name, value) => {
      const rule = rules[name];
      if (!rule) return null;
      const err = rule(value);
      setErrors((prev) => ({ ...prev, [name]: err || null }));
      return err || null;
    },
    [rules],
  );

  const validateAll = useCallback(
    (values) => {
      const next = {};
      let ok = true;
      for (const [name, rule] of Object.entries(rules)) {
        const err = rule(values[name]);
        if (err) { next[name] = err; ok = false; }
        else next[name] = null;
      }
      setErrors(next);
      return ok;
    },
    [rules],
  );

  const clearError = useCallback((name) => {
    setErrors((prev) => ({ ...prev, [name]: null }));
  }, []);

  return { errors, validate, validateAll, clearError };
}
