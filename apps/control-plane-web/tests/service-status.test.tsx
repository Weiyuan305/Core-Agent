// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ServiceStatus } from "../src/client/features/services/service-status.js";

afterEach(cleanup);

it("renders the approved calm service preparation status without technical detail", () => {
  render(<ServiceStatus state="preparing" />);
  expect(screen.getByText("服务正在准备，完成后即可开始对话。")).not.toBeNull();
  expect(document.body.textContent).not.toMatch(/(?:SERVICE_PREPARING|runtime|container|provider)/iu);
});
