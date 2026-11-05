/**
 * Host half of dsh-chat-ui.
 *
 * Job: make sure one "chat working folder" exists and is registered with DSH.
 * Every DSH session belongs to a Workspace (a real directory), and that folder
 * is the agent's cwd and write scope. With the workspace picker hidden, new
 * chats would otherwise follow "the last used workspace" and scatter, so the
 * plugin pins them to a single place.
 *
 * Location: `chatWorkspacePath` (absolute) or `$DSH_HOME/chat`.
 *
 * The client half cannot read this plugin's config, so the host marks the
 * folder by giving its Workspace the title {@link CHAT_TITLE}. DSH keeps
 * Workspace titles unique, so exactly one Workspace carries the mark and the
 * client pins new chats to it, whatever the folder is called. (Older builds
 * matched any folder named `chat`, which could pick an unrelated project.)
 *
 * No credentials, provider or model settings are touched.
 */
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

export const name = 'dsh-chat-ui'
export const inject = ['workspaceController', 'workspaceRegistry']

/** Workspace title that marks the chat folder. Keep in sync with client.js. */
const CHAT_TITLE = 'chat (dsh-chat-ui)'

/**
 * Resolve $DSH_HOME the same way DSH does (explicit env, else `~/.dsh`), so the
 * published plugin does not have to depend on a DSH-internal package.
 * @param {Record<string, string | undefined>} env
 * @returns {string} absolute home directory
 */
function resolveDshHome(env = process.env) {
  const configured = (env.DSH_HOME ?? '').trim()
  if (configured) return resolve(configured)
  return join(homedir(), '.dsh')
}

/**
 * Give a Workspace a title, falling back to numbered variants when another
 * Workspace already uses it (titles are unique).
 * @returns {Promise<string>} the title that was applied
 */
async function renameUnique(controller, registry, workspaceId, wanted) {
  const taken = new Set(registry.list().filter((w) => w.id !== workspaceId).map((w) => w.title))
  let title = wanted
  for (let n = 2; taken.has(title); n++) title = `${wanted} (${n})`
  await controller.rename({ workspaceId, title })
  return title
}

export function apply(ctx, config) {
  const configured = typeof config?.chatWorkspacePath === 'string' ? config.chatWorkspacePath.trim() : ''
  // 相対パスは DSH の作業ディレクトリ基準になってしまうので、ここで絶対パスにする
  const path = configured ? resolve(configured) : join(resolveDshHome(), 'chat')

  ctx.effect(() => {
    let disposed = false
    // The registry rejects a path that does not exist yet, so create it first.
    // `create` itself is idempotent and returns the registered row when present.
    ;(async () => {
      await mkdir(path, { recursive: true })
      const { workspace } = await ctx.workspaceController.create({ path })
      if (disposed) return
      // After chatWorkspacePath changes, the previous folder still carries the
      // mark. Hand it back its folder name so the client sees one chat folder.
      // 1 件失敗しても、今のフォルダへの印付けは続ける。
      for (const other of ctx.workspaceRegistry.list()) {
        if (other.id === workspace.workspaceId || other.title !== CHAT_TITLE) continue
        try {
          const title = await renameUnique(ctx.workspaceController, ctx.workspaceRegistry, other.id, basename(other.path) || 'workspace')
          ctx.logger?.info?.(`dsh-chat-ui: previous chat folder ${other.path} renamed to "${title}"`)
        } catch (error) {
          ctx.logger?.warn?.(`dsh-chat-ui: could not rename the previous chat folder ${other.path}: ${error?.message ?? error}`)
        }
      }
      if (workspace.title !== CHAT_TITLE) {
        await ctx.workspaceController.rename({ workspaceId: workspace.workspaceId, title: CHAT_TITLE })
      }
      if (disposed) return
      ctx.logger?.info?.(`dsh-chat-ui: chat workspace ready: ${workspace.path}`)
    })().catch((error) => {
      ctx.logger?.warn?.(`dsh-chat-ui: chat workspace ${path} could not be prepared: ${error?.message ?? error}`)
    })
    return () => {
      disposed = true
    }
  }, 'dsh-chat-ui: chat workspace')
}
