package gateway.session

import gateway.cache.EnumTypes

/**
 * Which top-level interface the client has and where interfaces are mounted on it.
 *
 * tsps addresses every gameframe mount by its component on the resizable root (161) and lets
 * the browser move it to the active root. The official client needs the real component, which
 * the cache's per-root redirect enums give.
 */
class InterfaceTree(private val enums: EnumTypes) {
    var root: Int = RESIZABLE_ROOT
        private set

    /** Group → the component it is mounted on, for WIDGET_OPEN/WIDGET_CLOSE, which carry none. */
    private val mounts = HashMap<Int, Int>()

    /** The resizable-root components tsps has mounted something on (the gameframe), kept across roots. */
    private val gameframe = LinkedHashSet<Int>()

    fun setRoot(group: Int) {
        root = group
        mounts.clear()
    }

    /** [uid] on the active root, when it addresses a resizable-root component. */
    fun remap(uid: Int): Int = remap(uid, root)

    /** [uid] on [onRoot], when it addresses a resizable-root component. */
    fun remap(uid: Int, onRoot: Int): Int {
        if (uid ushr 16 != RESIZABLE_ROOT || onRoot == RESIZABLE_ROOT) return uid
        val redirect = REDIRECT_ENUM_BY_ROOT[onRoot] ?: return uid
        return enums[redirect][uid] ?: uid
    }

    /** tsps mounted a group on resizable-root component [uid], or (false) closed it. */
    fun gameframe(uid: Int, mounted: Boolean) {
        if (uid ushr 16 != RESIZABLE_ROOT) return
        if (mounted) gameframe += uid else gameframe -= uid
    }

    /** Each gameframe mount as it sits on [from] and on the active root, where the two differ. */
    fun moves(from: Int): List<Pair<Int, Int>> =
        gameframe.map { remap(it, from) to remap(it) }.filter { (source, target) -> source != target }

    fun mounted(target: Int, group: Int) {
        mounts[group] = target
    }

    fun unmounted(target: Int): Int? = mounts.entries.firstOrNull { it.value == target }?.key?.also(mounts::remove)

    /** Where tsps's untargeted WIDGET_OPEN puts a group: the main modal area. */
    fun modalTarget(): Int = remap((RESIZABLE_ROOT shl 16) or MAIN_MODAL)

    fun targetOf(group: Int): Int? = mounts.remove(group)

    companion object {
        const val RESIZABLE_ROOT = 161
        private const val MAIN_MODAL = 16

        /** Cache enums mapping each 161 component to a root's (the client's own pane redirects). */
        private val REDIRECT_ENUM_BY_ROOT = mapOf(548 to 1129, 164 to 1131, LOGIN_ROOT to 1132, 601 to 1745)

        /** The root live logs in to, which holds the welcome screen at [WELCOME_SLOT]. */
        const val LOGIN_ROOT = 165
        const val WELCOME_SLOT = 40
    }
}
