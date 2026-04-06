import { STORYBOARD_NEW_SELECTION_ID } from './storyboard-utils'
import type { FrameType } from './workflow-data'

export interface StoryboardBoardTile {
  tileKey: string
  kind: 'existing' | 'missing-end'
  selectionId: string
  sourceSelectionId: string
  storyboardImageId: string
  shotId: string
  frameType: FrameType
  goal: string
  imageUrl: string | null
  imageExists: boolean
  isSelected: boolean
}

interface StoryboardPageSelectedEntry {
  storyboardImageId: string
  entry: {
    frameType: FrameType
    goal: string
  }
}

export interface StoryboardPageSelectionState {
  selectedImageId: string
  kind: 'existing' | 'missing-end' | 'new-start'
  selectedEntry: StoryboardPageSelectedEntry | null
}

interface RenderMediaBlockOptions {
  mediaType: 'image' | 'video'
  mediaUrl: string | null
  mediaExists: boolean
  alt: string
  placeholder: string
  placeholderVariant?: 'missing' | 'omitted'
  className: string
}

export interface StoryboardPageRenderOptions {
  boardTiles: StoryboardBoardTile[]
  selected: StoryboardPageSelectionState
  selectionLabel: string
  selectionHelp: string
  fastImageModel: string | null
  referenceEditorValue: string
  saveButtonLabel: string
  primaryButtonLabel: string
  showDirectionField: boolean
  showDropImageAction: boolean
  dropImageConfirmMessage: string | null
  jobBannerHtml: string
}

interface StoryboardPageRenderUtils {
  appendSearchParams: (
    href: string,
    entries: Record<string, string | null | undefined | boolean>,
  ) => string
  escapeHtml: (value: string) => string
  renderMediaBlock: (options: RenderMediaBlockOptions) => string
  renderPlaceholder: (label: string, variant?: 'missing' | 'omitted') => string
  frameTypeLabel: (frameType: FrameType) => string
}

function renderStoryboardGoalFallback(
  goal: string,
  utils: Pick<StoryboardPageRenderUtils, 'escapeHtml'>,
) {
  return `
    <div class="storyboard-thumb-goal">
      <span class="storyboard-thumb-goal-copy">${utils.escapeHtml(goal)}</span>
    </div>
  `
}

function renderStoryboardBoardTile(tile: StoryboardBoardTile, utils: StoryboardPageRenderUtils) {
  const label =
    tile.kind === 'missing-end'
      ? `${tile.storyboardImageId} (Optional end frame placeholder)`
      : `${tile.storyboardImageId} (${utils.frameTypeLabel(tile.frameType)} frame)`
  const hasGoalFallback =
    tile.kind === 'existing' && !tile.imageExists && tile.goal.trim().length > 0

  return `
    <a
      class="${[
        'storyboard-thumb',
        tile.kind === 'missing-end' ? 'storyboard-thumb-empty' : '',
        tile.isSelected ? 'storyboard-thumb-active' : '',
      ]
        .filter(Boolean)
        .join(' ')}"
      href="${utils.appendSearchParams('/storyboard', { image: tile.selectionId })}"
      aria-label="${utils.escapeHtml(label)}"
      title="${utils.escapeHtml(label)}"
      data-storyboard-tile-key="${utils.escapeHtml(tile.tileKey)}"
      data-storyboard-selection-id="${utils.escapeHtml(tile.selectionId)}"
      data-storyboard-kind="${utils.escapeHtml(tile.kind)}"
      data-storyboard-source-selection-id="${utils.escapeHtml(tile.sourceSelectionId)}"
    >
      <div class="${[
        'storyboard-thumb-media',
        tile.kind === 'missing-end' ? 'storyboard-thumb-media-optional-end' : '',
      ]
        .filter(Boolean)
        .join(' ')}">
        ${
          tile.kind === 'missing-end'
            ? ''
            : hasGoalFallback
              ? renderStoryboardGoalFallback(tile.goal, utils)
              : utils.renderMediaBlock({
                  mediaType: 'image',
                  mediaUrl: tile.imageUrl,
                  mediaExists: tile.imageExists,
                  alt: tile.storyboardImageId,
                  placeholder: '',
                  className: 'version-media',
                })
        }
      </div>
    </a>
  `
}

function renderStoryboardAddTile(
  isSelected: boolean,
  utils: Pick<StoryboardPageRenderUtils, 'appendSearchParams'>,
) {
  return `
    <a
      class="${['storyboard-thumb', 'storyboard-thumb-empty', 'storyboard-thumb-add-tile', isSelected ? 'storyboard-thumb-active' : ''].filter(Boolean).join(' ')}"
      href="${utils.appendSearchParams('/storyboard', { image: STORYBOARD_NEW_SELECTION_ID })}"
      aria-label="Add storyboard frame"
      title="Add storyboard frame"
    >
      <div class="storyboard-thumb-media storyboard-thumb-add">
        <span class="storyboard-thumb-add-icon" aria-hidden="true">+</span>
      </div>
    </a>
  `
}

function renderStoryboardReorderScript() {
  return `
    <script src="/vendor/sortablejs.min.js"></script>
    <script>
      window.addEventListener('load', function () {
        var shell = document.querySelector('[data-storyboard-reorder-shell]');
        var grid = document.querySelector('[data-storyboard-grid]');
        var toggleButton = document.querySelector('[data-storyboard-reorder-toggle]');

        if (!shell || !grid || !toggleButton) {
          return;
        }

        if (typeof window.Sortable === 'undefined') {
          toggleButton.setAttribute('disabled', 'disabled');
          toggleButton.setAttribute('title', 'SortableJS did not load');
          return;
        }

        var sortable = null;
        var isReordering = false;
        var originalOrder = [];

        function getTileItems() {
          return Array.from(grid.querySelectorAll('[data-storyboard-tile-key]'));
        }

        function getTileKeys() {
          return getTileItems()
            .map(function (item) {
              return item.getAttribute('data-storyboard-tile-key');
            })
            .filter(function (value) {
              return typeof value === 'string' && value.length > 0;
            });
        }

        function arraysEqual(left, right) {
          if (left.length !== right.length) {
            return false;
          }

          return left.every(function (value, index) {
            return value === right[index];
          });
        }

        function setButtonLabel(label) {
          toggleButton.textContent = label;
        }

        function enterReorderMode() {
          if (isReordering) {
            return;
          }

          originalOrder = getTileKeys();
          isReordering = true;
          shell.classList.add('storyboard-grid-panel-reordering');
          setButtonLabel('Save Reorder');

          sortable = window.Sortable.create(grid, {
            animation: 180,
            draggable: '[data-storyboard-tile-key]',
            invertSwap: true,
            swapThreshold: 0.68,
            ghostClass: 'storyboard-thumb-ghost',
            chosenClass: 'storyboard-thumb-chosen',
            dragClass: 'storyboard-thumb-drag',
          });
        }

        function exitReorderMode() {
          if (sortable) {
            sortable.destroy();
            sortable = null;
          }

          isReordering = false;
          shell.classList.remove('storyboard-grid-panel-reordering');
          toggleButton.disabled = false;
          setButtonLabel('Reorder');
        }

        async function saveReorder() {
          var tileKeys = getTileKeys();

          if (arraysEqual(tileKeys, originalOrder)) {
            exitReorderMode();
            return;
          }

          toggleButton.disabled = true;

          var selectedTile = document.querySelector(
            '.storyboard-thumb-active[data-storyboard-tile-key]',
          );
          var selectedTileKey =
            selectedTile instanceof Element
              ? selectedTile.getAttribute('data-storyboard-tile-key')
              : null;

          try {
            var response = await fetch('/storyboard/reorder', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                tileKeys: tileKeys,
                selectedTileKey: selectedTileKey,
              }),
            });

            if (!response.ok) {
              var errorMessage = 'Failed to save storyboard order.';

              try {
                var errorPayload = await response.json();

                if (
                  errorPayload &&
                  typeof errorPayload === 'object' &&
                  typeof errorPayload.error === 'string' &&
                  errorPayload.error.trim().length > 0
                ) {
                  errorMessage = errorPayload.error.trim();
                }
              } catch (error) {}

              throw new Error(errorMessage);
            }

            var payload = await response.json();
            var redirectUrl =
              payload &&
              typeof payload === 'object' &&
              typeof payload.redirectUrl === 'string' &&
              payload.redirectUrl.trim().length > 0
                ? payload.redirectUrl
                : '/storyboard';

            window.location.assign(redirectUrl);
          } catch (error) {
            toggleButton.disabled = false;
            window.alert(
              error instanceof Error ? error.message : 'Failed to save storyboard order.',
            );
          }
        }

        toggleButton.addEventListener('click', function () {
          if (!isReordering) {
            enterReorderMode();
            return;
          }

          void saveReorder();
        });

        document.addEventListener('keydown', function (event) {
          if (!isReordering || event.key !== 'Escape') {
            return;
          }

          event.preventDefault();
          void saveReorder();
        });

        grid.addEventListener('click', function (event) {
          if (!isReordering) {
            return;
          }

          var tile =
            event.target instanceof Element
              ? event.target.closest('[data-storyboard-tile-key]')
              : null;

          if (tile) {
            event.preventDefault();
          }
        });

        grid.addEventListener('dragstart', function (event) {
          if (!isReordering) {
            event.preventDefault();
          }
        });
      });
    </script>
  `
}

export function renderStoryboardPageContent(
  options: StoryboardPageRenderOptions,
  utils: StoryboardPageRenderUtils,
) {
  return {
    content: `<section class="storyboard-editor-layout">
      <div class="panel storyboard-grid-panel" data-storyboard-reorder-shell>
        <div class="storyboard-grid-toolbar">
          <p class="section-title">Board</p>
          ${
            options.boardTiles.length > 0
              ? `<button class="button-secondary" type="button" data-storyboard-reorder-toggle>Reorder</button>`
              : ''
          }
        </div>
        <div class="storyboard-grid" data-storyboard-grid>
          ${options.boardTiles.map((tile) => renderStoryboardBoardTile(tile, utils)).join('')}
          <div data-storyboard-add-tile>
            ${renderStoryboardAddTile(options.selected.kind === 'new-start', utils)}
          </div>
        </div>
      </div>
      <div class="storyboard-editor-pane">
        ${options.jobBannerHtml}
        <section class="panel">
          <div class="meta-stack">
            <p class="section-title">${utils.escapeHtml(options.selectionLabel)}</p>
            <p class="form-note">${utils.escapeHtml(options.selectionHelp)}</p>
            <p class="small">Each render creates one minimal sketch-style storyboard frame with ${utils.escapeHtml(options.fastImageModel ?? 'the configured fast image model')}.</p>
          </div>
          <form method="post" action="/storyboard/save">
            <input type="hidden" name="selectedImageId" value="${utils.escapeHtml(options.selected.selectedImageId)}">
            <label class="field-label" for="storyboard-goal">Goal</label>
            <textarea id="storyboard-goal" name="goal" required>${utils.escapeHtml(options.selected.selectedEntry?.entry.goal ?? '')}</textarea>
            <label class="field-label" for="storyboard-references">Source References</label>
            <textarea id="storyboard-references" name="referencesJson" spellcheck="false">${utils.escapeHtml(options.referenceEditorValue)}</textarea>
            ${
              options.showDirectionField
                ? `<label class="field-label" for="storyboard-direction">Direction</label>
            <textarea id="storyboard-direction" name="regenerateRequest" placeholder="Optional. Describe what should change in the existing image."></textarea>`
                : ''
            }
            <div class="form-actions">
              <button class="button-secondary" type="submit" formaction="/storyboard/save">${utils.escapeHtml(options.saveButtonLabel)}</button>
              <button class="button-primary" type="submit" formaction="/storyboard/render">${utils.escapeHtml(options.primaryButtonLabel)}</button>
            </div>
          </form>
        </section>
        ${
          options.showDropImageAction &&
          options.selected.selectedEntry &&
          options.dropImageConfirmMessage
            ? `
              <section class="panel">
                <p class="section-title">Drop Image</p>
                <p class="form-note">${utils.escapeHtml(
                  'Remove the current storyboard image artifact while keeping this storyboard slot and its planning data in place.',
                )}</p>
                <form method="post" action="/storyboard/drop-image" onsubmit="return window.confirm(${utils.escapeHtml(
                  JSON.stringify(options.dropImageConfirmMessage),
                )})">
                  <input type="hidden" name="selectedImageId" value="${utils.escapeHtml(options.selected.selectedImageId)}">
                  <button class="button-danger" type="submit">Drop image</button>
                </form>
              </section>
            `
            : ''
        }
      </div>
    </section>`,
    extraBodyHtml: options.boardTiles.length > 0 ? renderStoryboardReorderScript() : '',
  }
}
