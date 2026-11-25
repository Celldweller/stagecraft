/**
 * Tag labels on browser tiles: as many as fit into one line, in display order, the rest behind a "+n" chip and
 * shown on hover (see styles/stagecraft.css, `.stage-tile-tags`).
 *
 * The template renders every tag of a tile plus a hidden chip. Fitting measures the labels' natural widths once
 * per pass and marks the overflow with `stage-tile-tag-extra`; CSS order then puts the chip between the fitting
 * labels and the extras, without moving DOM nodes.
 *
 * Cost (tiles may number in the hundreds, most of them off screen with `content-visibility: auto`):
 * - Only tiles near the visible area are fitted: an IntersectionObserver on the scroll container, with a margin
 *   of one container height, fits tiles before they scroll into view.
 * - A width change of the grid fits the tiles near the view again and marks all others stale; they are fitted
 *   when they come near.
 * - Each pass writes (reset), then reads (one forced layout for the batch), then writes the result, all in one
 *   task, so nothing is painted in between.
 */
import { fitTagCount } from "../lib/tags.mjs";

const EXTRA = "stage-tile-tag-extra";

/** Labels whose measured widths may exceed the room by rounding only. */
const ROUNDING = 0.5;

export class TileTagFitter {
  /** @type {IntersectionObserver|null} */
  #intersection = null;

  /** @type {ResizeObserver|null} */
  #resize = null;

  /** Tiles currently near the visible area. */
  #near = new Set();

  /** Incremented on every width change; a tile fitted in an older generation is stale. */
  #generation = 0;

  /** Grid width of the current generation. */
  #width = 0;

  /**
   * Observe a freshly rendered grid and fit its first tiles right away (before the first paint).
   * @param {HTMLElement} grid         The tile list.
   * @param {HTMLElement} scroller     Its scroll container.
   * @param {number} eager             How many leading tiles to fit synchronously.
   */
  attach(grid, scroller, eager) {
    this.detach();
    const tiles = [...grid.querySelectorAll(".stage-tile")];
    this.#width = grid.clientWidth;
    this.#fit(tiles.slice(0, eager).filter(t => !t.hidden));

    this.#intersection = new IntersectionObserver(entries => {
      const due = [];
      for ( const entry of entries ) {
        const tile = /** @type {HTMLElement} */ (entry.target);
        if ( !entry.isIntersecting ) {
          this.#near.delete(tile);
          continue;
        }
        this.#near.add(tile);
        if ( Number(tile.dataset.fitGeneration) !== this.#generation ) due.push(tile);
      }
      this.#fit(due);
    }, {root: scroller, rootMargin: "100% 0px"});
    for ( const tile of tiles ) this.#intersection.observe(tile);

    this.#resize = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      if ( !width || (Math.abs(width - this.#width) < ROUNDING) ) return;
      this.#width = width;
      this.#generation++;
      this.#fit([...this.#near].filter(t => t.isConnected && !t.hidden));
    });
    this.#resize.observe(grid);
  }

  /** Stop observing (grid re-rendered or window closed). */
  detach() {
    this.#intersection?.disconnect();
    this.#resize?.disconnect();
    this.#intersection = this.#resize = null;
    this.#near.clear();
  }

  /**
   * Fit a batch of tiles.
   * @param {HTMLElement[]} tiles
   */
  #fit(tiles) {
    const jobs = [];
    // Write: every label in the line, the chip with the largest count it can show (an upper bound of its width).
    for ( const tile of tiles ) {
      const container = tile.querySelector(".stage-tile-tags");
      const chip = container?.querySelector(".stage-tile-more-chip");
      const labels = container ? [...container.querySelectorAll(".stage-tile-tag")] : [];
      if ( !container || !chip || !labels.length ) continue;
      for ( const label of labels ) {
        label.classList.remove(EXTRA);
        label.style.removeProperty("max-inline-size");
      }
      chip.hidden = false;
      chip.querySelector(".stage-tile-more-count").textContent = `+${labels.length}`;
      jobs.push({tile, container, chip, labels});
    }
    if ( !jobs.length ) return;

    // Read: one layout for the whole batch.
    const gap = parseFloat(getComputedStyle(jobs[0].container).columnGap) || 0;
    for ( const job of jobs ) {
      job.available = job.container.clientWidth + ROUNDING;
      job.chipWidth = job.chip.getBoundingClientRect().width;
      job.widths = job.labels.map(label => label.getBoundingClientRect().width);
    }

    // Write: the result.
    for ( const {tile, container, chip, labels, available, chipWidth, widths} of jobs ) {
      const {count, shrinkFirst} = fitTagCount(widths, {available, gap, chip: chipWidth});
      const extra = labels.slice(count);
      for ( const label of extra ) label.classList.add(EXTRA);
      if ( shrinkFirst ) labels[0].style.maxInlineSize = `${Math.max(available - ROUNDING - chipWidth - gap, 0)}px`;
      chip.hidden = !extra.length;
      chip.querySelector(".stage-tile-more-count").textContent = `+${extra.length}`;
      chip.dataset.tooltipText = extra.map(label => label.dataset.tooltipText).join(", ");
      container.dataset.fitted = "";
      tile.dataset.fitGeneration = String(this.#generation);
    }
  }
}
