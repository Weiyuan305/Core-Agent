import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ConsultantWorkspaceApp } from "./app.js";
import "./styles/tokens.css";
import "./styles/workspace.css";
import "./styles/accessibility.css";

const root = document.getElementById("root");
if (root === null) throw new Error("CLIENT_CONFIGURATION_INVALID");

createRoot(root).render(
  <StrictMode>
    <ConsultantWorkspaceApp />
  </StrictMode>,
);
