import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { useThemeStore } from "./stores/themeStore";

function ThemeApplier() {
  const theme = useThemeStore((state) => state.theme);
  useEffect(() => {
    document.documentElement.classList.remove("dark", "light");
    document.documentElement.classList.add(theme);
  }, [theme]);
  return null;
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <BrowserRouter>
    <ThemeApplier />
    <App />
  </BrowserRouter>,
);
