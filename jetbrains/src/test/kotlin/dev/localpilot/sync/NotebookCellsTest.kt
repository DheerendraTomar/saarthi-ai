package dev.localpilot.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The cell model over PyCharm's notebook Document (the `#%%` source rendering of the `.ipynb`, see
 * [NotebookCells]). Pure JUnit: the parser works on text, so no IDE is needed here; [NotebookSyncTest] drives the
 * same code through a real `.ipynb` loaded by the Jupyter plugin.
 */
class NotebookCellsTest {
    /** `asSource()` of: code "import os\nx = 1", markdown "# Title", code "" (empty), raw "raw text", code "y = 2". */
    private val source = "#%%\nimport os\nx = 1\n#%% md\n# Title\n#%%\n\n#%% raw\nraw text\n#%%\ny = 2"

    @Test
    fun cells_parsed_with_offsets_and_kinds() {
        val cells = NotebookCells.parse(source, "python")
        assertEquals(listOf(0, 1, 2, 3, 4), cells.map { it.index })
        assertEquals(
            listOf(CellKind.CODE, CellKind.MARKDOWN, CellKind.CODE, CellKind.RAW, CellKind.CODE),
            cells.map { it.kind },
        )
        assertEquals(listOf("python", "markdown", "python", "raw", "python"), cells.map { it.language })
        assertEquals(listOf("import os\nx = 1", "# Title", "", "raw text", "y = 2"), cells.map { it.text })
        for (cell in cells) {
            assertEquals(cell.text, source.substring(cell.startOffset, cell.endOffset))
            assertEquals("#%%", source.substring(cell.markerOffset, cell.markerOffset + 3))
        }
        assertEquals(4, cells[0].startOffset)
        assertEquals(19, cells[0].endOffset)
        assertNull(cells[0].id)

        // A trailing marker with nothing after it is an empty last cell; a document that is not a `#%%` rendering
        // (raw JSON in an IDE without the notebook editor, or empty) has no cells.
        val trailing = NotebookCells.parse("#%%\na\n#%%", "python")
        assertEquals(listOf("a", ""), trailing.map { it.text })
        assertEquals(9, trailing[1].startOffset)
        assertEquals(emptyList<Cell>(), NotebookCells.parse("{\"cells\": []}", "python"))
        assertEquals(emptyList<Cell>(), NotebookCells.parse("", "python"))
        // Source lines starting with `#%%` are escaped as `##%%` by the platform: not markers.
        assertEquals(listOf("##%% not a cell\nz"), NotebookCells.parse("#%%\n##%% not a cell\nz", "python").map { it.text })
        // Other cell headers (`#%% sql`, …) are non-code.
        assertEquals(listOf(CellKind.CODE, CellKind.RAW), NotebookCells.parse("#%%\na\n#%% sql\nselect 1", "python").map { it.kind })
    }

    @Test
    fun caret_maps_to_cell_relative_position_after_insertion_above() {
        val before = NotebookCells.parse(source, "python")
        val caret = source.indexOf("= 2") // cell 4, line 0, character 2
        val (cell, pos) = NotebookCells.caretToCell(before, caret)!!
        assertEquals(4, cell.index)
        assertEquals(Position(0, 2), pos)

        // Two cells (code + markdown) inserted above: same text, cell 6 now, same cell-relative position.
        val inserted = "#%%\nnew = 0\nmore = 1\n#%% md\nnote\n"
        val after = inserted + source
        val cells = NotebookCells.parse(after, "python")
        val (moved, movedPos) = NotebookCells.caretToCell(cells, caret + inserted.length)!!
        assertEquals(6, moved.index)
        assertEquals("y = 2", moved.text)
        assertEquals(Position(0, 2), movedPos)

        // A multi-line cell: second line, UTF-16 columns (the emoji is two code units).
        val emoji = "#%%\na😀b\nc😀d"
        val ec = NotebookCells.parse(emoji, "python")
        assertEquals(Position(1, 3), NotebookCells.caretToCell(ec, emoji.indexOf("d"))!!.second)
        assertEquals(Position(0, 0), NotebookCells.caretToCell(ec, 4)!!.second)
        // End of the cell content is inside the cell.
        assertEquals(Position(1, 4), NotebookCells.caretToCell(ec, emoji.length)!!.second)

        // Markdown / raw cells and marker lines map to nothing.
        assertNull(NotebookCells.caretToCell(before, source.indexOf("Title")))
        assertNull(NotebookCells.caretToCell(before, source.indexOf("raw text")))
        assertNull(NotebookCells.caretToCell(before, 1))
        assertNull(NotebookCells.caretToCell(before, -1))
    }

    @Test
    fun virtual_uris_and_concat_doc() {
        val nb = "file:///work/My%20Notebooks/a.ipynb"
        assertEquals("file:///work/My%20Notebooks/a.ipynb.cell3.py", NotebookCells.cellUri(nb, 3, "py"))
        assertEquals("file:///work/My%20Notebooks/a.ipynb.cells.py", NotebookCells.concatUri(nb, "py"))

        assertEquals("py", NotebookCells.extForLanguage("python"))
        assertEquals("py", NotebookCells.extForLanguage("Python"))
        assertEquals("jl", NotebookCells.extForLanguage("julia"))
        assertEquals("r", NotebookCells.extForLanguage("R"))
        assertEquals("txt", NotebookCells.extForLanguage("scala"))

        val cells = NotebookCells.parse(source, "python")
        // Code cells only, in order, joined by a blank line (as the VS Code and JupyterLab clients).
        assertEquals("import os\nx = 1\n\n\n\ny = 2", NotebookCells.concatText(cells))
    }

    @Test
    fun markdown_cells_skipped() {
        val cells = NotebookCells.parse(source, "python")
        // Only code cells get a virtual document; indices are notebook indices (markdown/raw included).
        assertEquals(listOf(0, 2, 4), NotebookCells.codeCells(cells).map { it.index })
        assertEquals(emptyList<Cell>(), NotebookCells.codeCells(NotebookCells.parse("#%% md\n# only text", "python")))
    }

    @Test
    fun kernel_language_from_notebook_json() {
        val json = """
            {"cells": [{"cell_type": "code", "source": ["s = \"\\\"language_info\\\": {\\\"name\\\": \\\"julia\\\"}\""]}],
             "metadata": {"kernelspec": {"display_name": "R", "language": "R", "name": "ir"},
                          "language_info": {"codemirror_mode": {"name": "ipython"}, "name": "R", "version": "4.3"}},
             "nbformat": 4}
        """.trimIndent()
        assertEquals("r", NotebookCells.kernelLanguageOf(json))
        assertEquals("python", NotebookCells.kernelLanguageOf("""{"metadata": {"kernelspec": {"language": "python"}}}"""))
        assertNull(NotebookCells.kernelLanguageOf("""{"cells": [], "metadata": {}}"""))
        assertNull(NotebookCells.kernelLanguageOf("not json"))
    }
}
