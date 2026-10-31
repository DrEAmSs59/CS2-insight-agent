import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { readShowGuideOnStartup } from "../utils/startupPreferences.js";

export function useStartupNavigation() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    if (pathname === "/" && !readShowGuideOnStartup()) {
      navigate("/library", { replace: true });
    }
  }, [pathname, navigate]);
}
