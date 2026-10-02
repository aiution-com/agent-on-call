import { exec } from 'child_process';
import { promisify } from 'util';
import { AgentGuard } from './sdk';
import { appendTaskLog } from './logs';

const execAsync = promisify(exec);

export interface RealTaskParams {
  orgId: string;
  type: 'repo_health' | 'security_audit' | 'build_test';
  customCommand?: string;
  apiUrl?: string;
}

export async function runRealAgentTask(params: RealTaskParams) {
  const apiUrl = params.apiUrl || 'http://127.0.0.1:3000';
  const orgId = params.orgId;

  const guard = new AgentGuard({
    apiUrl,
    orgId,
    agentName: 'production-system-worker',
    agentType: 'SRE & DevOps Agent',
    ownerEmail: 'sre@agentoncall.dev',
  });

  await guard.init();

  if (params.type === 'repo_health') {
    // 1. Create task first so we have taskId for live streaming logs
    const taskRes = await fetch(`${apiUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgId,
        title: 'Verify Repository Health & Build',
        description: 'Live autonomous agent inspecting local repository and verifying build.',
        source: 'real-worker',
        status: 'in_progress',
        budgetUsd: 0.10,
      }),
    });
    const taskData = (await taskRes.json()) as { id: string };
    const taskId = taskData.id;

    await appendTaskLog(taskId, '🤖 Agent initialized: production-system-worker (Node.js runtime)', 'info');
    await appendTaskLog(taskId, '🔍 Inspecting current git branch...', 'info');

    // Real git branch inspection
    const { stdout: branch } = await execAsync('git branch --show-current');
    const branchName = branch.trim();
    await appendTaskLog(taskId, `🌿 Active branch: [${branchName}]`, 'info');

    await appendTaskLog(taskId, '📜 Reading latest git commit history (git log -3)...', 'info');
    const { stdout: gitLog } = await execAsync('git log -3 --oneline');
    for (const line of gitLog.trim().split('\n')) {
      await appendTaskLog(taskId, `   commit: ${line}`, 'info');
    }

    await appendTaskLog(taskId, '📂 Checking working directory for uncommitted changes...', 'info');
    const { stdout: gitStatus } = await execAsync('git status --short');
    const modifiedCount = gitStatus.trim().split('\n').filter(Boolean).length;
    await appendTaskLog(taskId, `📁 Working tree clean status: ${modifiedCount} modified files found.`, 'info');

    const plannedCommand = 'npx tsc --build';
    await appendTaskLog(taskId, `⚠️ Sensitive action prepared: [${plannedCommand}]`, 'warn');
    await appendTaskLog(taskId, `🛡️ Triggering AgentOnCall Governance Gate: Action requires human sign-off.`, 'pause');
    await appendTaskLog(taskId, `📡 Dispatching approval card to Slack channel #agent-approvals...`, 'info');

    // 2. Guard with AgentOnCall
    const guardedResult = await guard.guard({
      taskId,
      taskTitle: `Verify Repository Health & Build on branch [${branchName}]`,
      type: 'execute_shell_command',
      context: {
        action: 'Compile TypeScript project & verify zero errors',
        command: plannedCommand,
        branch: branchName,
        modified_files: modifiedCount,
      },
      action: async () => {
        await appendTaskLog(taskId, `✅ Human operator APPROVED action! Resuming execution thread...`, 'success');
        await appendTaskLog(taskId, `⚙️ Spawning child process: [${plannedCommand}]`, 'info');

        const startTime = Date.now();
        const { stdout, stderr } = await execAsync(plannedCommand);
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);

        await appendTaskLog(taskId, `[stdout] ${stdout.trim() || 'TypeScript build completed with zero errors.'}`, 'stdout');
        if (stderr.trim()) {
          await appendTaskLog(taskId, `[stderr] ${stderr.trim()}`, 'warn');
        }
        await appendTaskLog(taskId, `🎉 Build verified in ${duration}s. Task successfully completed.`, 'success');

        return {
          executed: true,
          command: plannedCommand,
          stdout: stdout || 'Compilation successful (0 errors).',
          stderr,
        };
      },
    });

    return {
      taskId,
      task: 'repo_health',
      guardedResult,
    };
  }

  throw new Error(`Unknown task type: ${params.type}`);
}
