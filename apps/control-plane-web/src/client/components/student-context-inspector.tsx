import { motion, useReducedMotion } from "motion/react";

import { CloseIcon, RestartIcon } from "../icons.js";

interface StudentContextInspectorProps {
  readonly onClose: () => void;
  readonly onRestart: () => void;
  readonly restartError?: string | undefined;
  readonly restarting: boolean;
}

export function StudentContextInspector(props: StudentContextInspectorProps) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.aside
      animate={{ x: 0 }}
      aria-label="当前学生"
      className="student-inspector"
      exit={{ x: reduceMotion ? 0 : 24 }}
      initial={{ x: reduceMotion ? 0 : 24 }}
      transition={reduceMotion ? { duration: 0.12 } : { type: "spring", bounce: 0, duration: 0.4 }}
    >
      <header className="student-inspector__header">
        <h2>当前学生</h2>
        <button aria-label="关闭学生信息" className="icon-button" onClick={props.onClose} type="button">
          <CloseIcon />
        </button>
      </header>
      <dl className="student-context-list">
        <div>
          <dt>当前学生</dt>
          <dd>演示学生</dd>
        </div>
        <div>
          <dt>申请阶段</dt>
          <dd>方案规划</dd>
        </div>
        <div>
          <dt>下一节点</dt>
          <dd>确认选校</dd>
        </div>
      </dl>
      <div className="student-inspector__utility">
        <button
          className="restart-button"
          disabled={props.restarting}
          onClick={props.onRestart}
          type="button"
        >
          <RestartIcon />
          <span>{props.restarting ? "正在重新启动" : "重新启动服务"}</span>
        </button>
        {props.restartError === undefined ? null : <p role="alert">{props.restartError}</p>}
      </div>
    </motion.aside>
  );
}
