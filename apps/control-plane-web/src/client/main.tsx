import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ControlPlaneWebApp } from "./app.js";
import "./styles/tokens.css";
import "./styles/workspace.css";
import "./styles/auth.css";
import "./styles/accessibility.css";

const root = document.getElementById("root");
if (root === null) throw new Error("CLIENT_CONFIGURATION_INVALID");
const invitationSecret = consumeInvitationSecret();

function consumeInvitationSecret(): string | undefined {
  const url = new URL(window.location.href);
  const values = url.searchParams.getAll("invitation");
  url.searchParams.delete("invitation");
  if (values.length > 0) window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  if (values.length !== 1) return undefined;
  const value = values[0]!;
  return /^[A-Za-z0-9._~-]{32,4096}$/u.test(value) ? value : undefined;
}

createRoot(root).render(
  <StrictMode>
    <ControlPlaneWebApp {...(invitationSecret === undefined ? {} : { invitationSecret })} />
  </StrictMode>,
);
