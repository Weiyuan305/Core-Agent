import { ConversationIcon } from "../icons.js";

export function GlobalNavigationRail() {
  return (
    <aside aria-label="全局导航" className="global-rail">
      <div aria-label="Core Agent" className="global-rail__mark">CA</div>
      <button aria-current="page" aria-label="学生与对话" className="icon-button global-rail__destination" type="button">
        <ConversationIcon />
      </button>
    </aside>
  );
}
