import type { DriverMode } from '../../../../packages/runtime/index.ts';

export const WORKER_PROMPTS = {
  reply: '根据需求和可用上下文直接回复。默认仅输出回复正文。有渠道判断要求时按指定结构输出。禁止调用工具、访问文件或申请提权。',
  analysis: '仅通过 Host 提供的只读工具读取当前独立工作区及本轮明确授权的资料别名。禁止执行命令、联网、修改文件或访问未授权的资料。'
    + '结论应引用实际读取的仓库相对路径及相关内容；无法验证时说明原因。最终输出 JSON，对象包含 status（completed 或 incomplete）、summary 和实际引用的相对路径数组 paths。',
  repair: '仅修改当前独立工作区中项目允许的路径。不要申请扩大文件权限、联网或执行外部写操作。'
    + '需要审批时等待 Host 决定，禁止绕过审批、重复发起或把请求当成批准。'
    + '说明实际改动的仓库相对路径和可复核的结果。Host 会独立核对 Git 差异并运行项目管理员配置的验证命令。'
    + '最终输出 JSON，对象包含 status（completed 或 incomplete）、summary 和实际修改的相对路径数组 paths。',
} satisfies Record<DriverMode, string>;

export function buildWorkerPrompt(kind: DriverMode, input: { goal: string; context?: string; workspace?: string; allowedPaths?: string[]; referenceAliases?: string[] }) {
  const sections = [WORKER_PROMPTS[kind]];
  if (kind !== 'reply' && input.workspace) sections.push(`当前执行目录\n${input.workspace}`);
  if (kind === 'repair' && input.allowedPaths) sections.push(`项目允许修改的相对路径\n${JSON.stringify(input.allowedPaths)}`);
  if (kind === 'analysis' && input.referenceAliases?.length) sections.push(
    `本轮只读资料别名\n${input.referenceAliases.map(alias => `@refs/${alias}/`).join('\n')}\n引用资料时保留完整别名路径。结果仅在工作台内查看。`);
  sections.push(`当前需求\n${input.goal}`);
  if (input.context) sections.push(`可用上下文\n${input.context}`);
  return sections.join('\n\n');
}
