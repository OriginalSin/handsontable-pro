import {
  addClass,
  removeClass,
} from 'handsontable/helpers/dom/element';
import {isUndefined, isDefined} from 'handsontable/helpers/mixed';
import {isObject} from 'handsontable/helpers/object';
import {arrayMap} from 'handsontable/helpers/array';
import {rangeEach} from 'handsontable/helpers/number';
import BasePlugin from 'handsontable/plugins/_base';
import {registerPlugin} from 'handsontable/plugins';
import mergeSort from 'handsontable/utils/sortingAlgorithms/mergeSort';
import Hooks from 'handsontable/pluginHooks';
import {isPressedCtrlKey} from 'handsontable/utils/keyStateObserver';
import {mainSortComparator} from './comparatorEngine';
import {ColumnStatesManager} from './columnStatesManager';
import {getNextSortOrder, areValidSortStates, warnIfPluginsHasConflict} from './utils';
import {DomHelper, HEADER_CLASS} from './domHelper';
import RowsMapper from './rowsMapper';

import './multiColumnSorting.css';

Hooks.getSingleton().register('beforeColumnSort');
Hooks.getSingleton().register('afterColumnSort');

const APPEND_COLUMN_CONFIG_STRATEGY = 'append';
const REPLACE_COLUMN_CONFIG_STRATEGY = 'replace';

/**
 * @plugin MultiColumnSorting
 * @pro
 *
 * @description
 * This plugin sorts the view by columns (but does not sort the data source!). To enable the plugin, set the
 * {@link Options#multiColumnSorting} property to the correct value (see the examples below).
 *
 * @example
 * ```js
 * // as boolean
 * multiColumnSorting: true
 *
 * // as an object with initial sort config (sort ascending for column at index 1 and then sort descending for column at index 0)
 * multiColumnSorting: {
 *   initialConfig: [{
 *     column: 1,
 *     sortOrder: 'asc'
 *   }, {
 *     column: 0,
 *     sortOrder: 'desc'
 *   }]
 * }
 *
 * // as an object which define specific sorting options for all columns
 * multiColumnSorting: {
 *   sortEmptyCells: true, // true = the table sorts empty cells, false = the table moves all empty cells to the end of the table
 *   indicator: true, // true = shows indicator for all columns, false = don't show indicator for columns
 *   headerAction: true, // true = allow to click on the headers to sort, false = turn off possibility to click on the headers to sort
 *   compareFunctionFactory: function(sortOrder, columnMeta) {
 *     return function(value, nextValue) {
 *       // Some value comparisons which will return -1, 0 or 1...
 *     }
 *   }
 * }
 *
 * // as an object passed to the `column` property, allows specifying a custom options for the desired column.
 * // please take a look at documentation of `column` property: https://docs.handsontable.com/pro/Options.html#columns
 * columns: [{
 *   multiColumnSorting: {
 *     indicator: false, // set off indicator for the first column,
 *     sortEmptyCells: true,
 *     headerAction: false, // clicks on the first column won't sort
 *     compareFunctionFactory: function(sortOrder, columnMeta) {
 *       return function(value, nextValue) {
 *         return 0; // Custom compare function for the first column (don't sort)
 *       }
 *     }
 *   }
 * }]```
 *
 * @dependencies moment
 */
class MultiColumnSorting extends BasePlugin {
  constructor(hotInstance) {
    super(hotInstance);
    /**
     * Instance of column state manager.
     *
     * @private
     * @type {ColumnStatesManager}
     */
    this.columnStatesManager = new ColumnStatesManager();
    /**
     * Instance of DOM helper.
     *
     * @private
     * @type {DomHelper}
     */
    this.domHelper = new DomHelper(this.columnStatesManager);
    /**
     * Object containing visual row indexes mapped to data source indexes.
     *
     * @private
     * @type {RowsMapper}
     */
    this.rowsMapper = new RowsMapper(this);
    /**
     * It blocks the plugin translation, this flag is checked inside `onModifyRow` listener.
     *
     * @private
     * @type {Boolean}
     */
    this.blockPluginTranslation = true;
    /**
     * Flag which determine if read cell meta from the cache.
     *
     * @private
     * @type {Boolean}
     */
    this.readCellMetaFromCache = false;
  }

  /**
   * Checks if the plugin is enabled in the handsontable settings. This method is executed in {@link Hooks#beforeInit}
   * hook and if it returns `true` than the {@link MultiColumnSorting#enablePlugin} method is called.
   *
   * @returns {Boolean}
   */
  isEnabled() {
    return !!(this.hot.getSettings().multiColumnSorting);
  }

  /**
   * Enables the plugin functionality for this Handsontable instance.
   */
  enablePlugin() {
    if (this.enabled) {
      return;
    }

    warnIfPluginsHasConflict(this.hot.getSettings().columnSorting);

    this.addHook('afterTrimRow', () => this.sortByPresetSortState());
    this.addHook('afterUntrimRow', () => this.sortByPresetSortState());
    this.addHook('modifyRow', (row, source) => this.onModifyRow(row, source));
    this.addHook('unmodifyRow', (row, source) => this.onUnmodifyRow(row, source));
    this.addHook('afterUpdateSettings', (settings) => this.onAfterUpdateSettings(settings));
    this.addHook('afterGetColHeader', (column, TH) => this.onAfterGetColHeader(column, TH));
    this.addHook('beforeOnCellMouseDown', (event, coords, TD, controller) => this.beforeOnCellMouseDown(event, coords, TD, controller));
    this.addHook('afterOnCellMouseDown', (event, target) => this.onAfterOnCellMouseDown(event, target));
    this.addHook('afterCreateRow', (index, amount) => this.onAfterCreateRow(index, amount));
    this.addHook('afterRemoveRow', (index, amount) => this.onAfterRemoveRow(index, amount));
    this.addHook('afterInit', () => this.loadOrSortBySettings());

    // TODO: Workaround - it should be refactored.
    this.addHook('afterLoadData', () => {
      this.rowsMapper.clearMap();

      if (this.hot.view) {
        this.loadOrSortBySettings();
      }
    });

    if (this.hot.view) {
      this.loadOrSortBySettings();
    }
    super.enablePlugin();
  }

  /**
   * Disables the plugin functionality for this Handsontable instance.
   */
  disablePlugin() {
    this.readCellMetaFromCache = false;

    this.rowsMapper.clearMap();
    this.columnStatesManager.setSortStates([]);

    // The top overlay isn't rendered. Next `render` call narrows the header and remove sort indicator if necessary.
    this.hot.render();

    super.disablePlugin();
  }

  /**
   * Sorts the table by chosen columns and orders.
   *
   * @param {undefined|Object|Array} sortConfig Single column sort configuration or full sort configuration (for all sorted columns).
   * The configuration object contains `column` and `sortOrder` properties. First of them contains visual column index, the second one contains
   * sort order (`asc` for ascending, `desc` for descending).
   *
   * **Note**: Please keep in mind that every call of `sort` function set an entirely new sort order. Previous sort configs aren't preserved.
   *
   * @example
   * ```js
   * // sort ascending first visual column
   * hot.getPlugin('multiColumnSorting').sort({ column: 0, sortOrder: 'asc' });
   *
   * // sort first two visual column in the defined sequence
   * hot.getPlugin('multiColumnSorting').sort([{
   *   column: 1, sortOrder: 'asc'
   * }, {
   *   column: 0, sortOrder: 'desc'
   * }]);
   *
   *
   * @fires Hooks#beforeColumnSort
   * @fires Hooks#afterColumnSort
   */
  sort(sortConfig) {
    const currentSortConfig = this.getSortConfig();
    let destinationSortConfigs;

    // We always transfer configs defined as an array to `beforeColumnSort` and `afterColumnSort` hooks.
    if (isUndefined(sortConfig)) {
      destinationSortConfigs = [];

    } else if (Array.isArray(sortConfig)) {
      destinationSortConfigs = sortConfig;

    } else {
      destinationSortConfigs = [sortConfig];
    }

    const sortPossible = this.areValidSortConfigs(destinationSortConfigs);
    const allowSort = this.hot.runHooks('beforeColumnSort', currentSortConfig, destinationSortConfigs, sortPossible);

    if (allowSort === false) {
      return;
    }

    if (sortPossible) {
      const translateColumnToPhysical = ({column: visualColumn, ...restOfProperties}) =>
        ({ column: this.hot.toPhysicalColumn(visualColumn), ...restOfProperties });

      const destinationSortStates = arrayMap(destinationSortConfigs, (columnSortConfig) => translateColumnToPhysical(columnSortConfig));

      this.columnStatesManager.setSortStates(destinationSortStates);
      this.sortByPresetSortState();
      this.saveAllSortSettings();

      this.hot.render();
      this.hot.view.wt.draw(true); // TODO: Workaround? One test won't pass after removal.
    }

    this.hot.runHooks('afterColumnSort', currentSortConfig, this.getSortConfig(), sortPossible);
  }

  /**
   * Clear the sort performed on the table.
   */
  clearSort() {
    this.sort([]);
  }

  /**
   * Checks if the table is sorted (any column have to be sorted).
   *
   * @returns {Boolean}
   */
  isSorted() {
    return this.isEnabled() && !this.columnStatesManager.isListOfSortedColumnsEmpty();
  }

  /**
   * Get sort configuration for particular column or for all sorted columns. Objects contain `column` and `sortOrder` properties.
   *
   * **Note**: Please keep in mind that returned objects expose **visual** column index under the `column` key. They are handled by the `sort` function.
   *
   * @param {Number} [column] Visual column index.
   * @returns {undefined|Object|Array}
   */
  getSortConfig(column) {
    const translateColumnToVisual = ({column: physicalColumn, ...restOfProperties}) =>
      ({ column: this.hot.toVisualColumn(physicalColumn), ...restOfProperties });

    if (isDefined(column)) {
      const physicalColumn = this.hot.toPhysicalColumn(column);
      const columnSortState = this.columnStatesManager.getColumnSortState(physicalColumn);

      if (isDefined(columnSortState)) {
        return translateColumnToVisual(columnSortState);
      }

      return void 0;
    }

    const sortStates = this.columnStatesManager.getSortStates();

    return arrayMap(sortStates, (columnState) => translateColumnToVisual(columnState));
  }

  /**
   * Get if sort configs are valid.
   *
   * @private
   * @param {Array} sortConfig Sort configuration for all sorted columns. Objects contain `column` and `sortOrder` properties.
   * @returns {Boolean}
   */
  areValidSortConfigs(sortConfigs) {
    const sortedColumns = sortConfigs.map(({column}) => column);
    const numberOfColumns = this.hot.countCols();

    const onlyExistingVisualIndexes = sortedColumns.every((visualColumn) =>
      visualColumn <= numberOfColumns && visualColumn >= 0);
    const likeSortStates = sortConfigs; // We don't translate visual indexes to physical indexes.

    return areValidSortStates(likeSortStates) && onlyExistingVisualIndexes;
  }

  /**
   * Saves all sorting settings. Saving works only when {@link Options#persistentState} option is enabled.
   *
   * @private
   * @fires Hooks#persistentStateSave
   * @fires Hooks#multiColumnSorting
   */
  saveAllSortSettings() {
    const allSortSettings = this.columnStatesManager.getAllColumnsProperties();

    allSortSettings.initialConfig = this.columnStatesManager.getSortStates();

    this.hot.runHooks('persistentStateSave', 'multiColumnSorting', allSortSettings);
  }

  /**
   * Get all saved sorting settings. Loading works only when {@link Options#persistentState} option is enabled.
   *
   * @private
   * @returns {Object} Previously saved sort settings.
   *
   * @fires Hooks#persistentStateLoad
   */
  getAllSavedSortSettings() {
    const storedAllSortSettings = {};

    this.hot.runHooks('persistentStateLoad', 'multiColumnSorting', storedAllSortSettings);

    const allSortSettings = storedAllSortSettings.value;
    const translateColumnToVisual = ({column: physicalColumn, ...restOfProperties}) =>
      ({ column: this.hot.toVisualColumn(physicalColumn), ...restOfProperties });

    if (isDefined(allSortSettings) && Array.isArray(allSortSettings.initialConfig)) {
      allSortSettings.initialConfig = arrayMap(allSortSettings.initialConfig, translateColumnToVisual);
    }

    return allSortSettings;
  }

  /**
   * Get next sort configuration for particular column. Object contain `column` and `sortOrder` properties.
   *
   * **Note**: Please keep in mind that returned object expose **visual** column index under the `column` key.
   *
   * @private
   * @param {Number} column Visual column index.
   * @returns {undefined|Object}
   */
  getColumnNextConfig(column) {
    const physicalColumn = this.hot.toPhysicalColumn(column);

    if (this.columnStatesManager.isColumnSorted(physicalColumn)) {
      const columnSortConfig = this.getSortConfig(column);
      const sortOrder = getNextSortOrder(columnSortConfig.sortOrder);

      if (isDefined(sortOrder)) {
        columnSortConfig.sortOrder = sortOrder;

        return columnSortConfig;
      }

      return void 0;
    }

    const nrOfColumns = this.hot.countCols();

    if (Number.isInteger(column) && column >= 0 && column < nrOfColumns) {
      return {
        column,
        sortOrder: getNextSortOrder(void 0)
      };
    }

    return void 0;
  }

  /**
   * Get sort state with "next order" for particular column.
   *
   * @private
   * @param {Number} columnToChange Visual column index of column which order will be changed.
   * @param {String} strategyId ID of strategy. Possible values: 'append' and 'replace. The first one
   * change order of particular column and change it's position in the sort queue to the last one. The second one
   * just change order of particular column.
   *
   * **Note**: Please keep in mind that returned objects expose **visual** column index under the `column` key.
   *
   * @returns {Array}
   */
  getNextSortConfig(columnToChange, strategyId = APPEND_COLUMN_CONFIG_STRATEGY) {
    const physicalColumn = this.hot.toPhysicalColumn(columnToChange);
    const indexOfColumnToChange = this.columnStatesManager.getIndexOfColumnInSortQueue(physicalColumn);
    const isColumnSorted = this.columnStatesManager.isColumnSorted(physicalColumn);
    const currentSortConfig = this.getSortConfig();
    const nextColumnConfig = this.getColumnNextConfig(columnToChange);

    if (isColumnSorted) {
      if (isUndefined(nextColumnConfig)) {
        return [...currentSortConfig.slice(0, indexOfColumnToChange), ...currentSortConfig.slice(indexOfColumnToChange + 1)];
      }

      if (strategyId === APPEND_COLUMN_CONFIG_STRATEGY) {
        return [...currentSortConfig.slice(0, indexOfColumnToChange), ...currentSortConfig.slice(indexOfColumnToChange + 1), nextColumnConfig];

      } else if (strategyId === REPLACE_COLUMN_CONFIG_STRATEGY) {
        return [...currentSortConfig.slice(0, indexOfColumnToChange), nextColumnConfig, ...currentSortConfig.slice(indexOfColumnToChange + 1)];
      }
    }

    if (isDefined(nextColumnConfig)) {
      return currentSortConfig.concat(nextColumnConfig);
    }

    return currentSortConfig;
  }

  /**
   * This function is workaround for not working inheriting for non-primitive cell meta values. It change column setting object
   * to properly created object by cascade settings.
   *
   * @private
   * @param {Number} column Visual column index.
   * @returns {Object}
   */
  overwriteFirstCellSettings(column) {
    const pluginMainSettings = this.hot.getSettings().multiColumnSorting;
    const storedColumnProperties = this.columnStatesManager.getAllColumnsProperties();
    const cellMeta = this.hot.getCellMeta(0, column);
    const columnMeta = Object.getPrototypeOf(cellMeta);
    const columnMetaHasPluginSettings = Object.hasOwnProperty.call(columnMeta, 'multiColumnSorting');
    const pluginColumnConfig = columnMetaHasPluginSettings ? columnMeta.multiColumnSorting : {};

    // After `disablePlugin` call.
    if (pluginMainSettings === false) {
      cellMeta.multiColumnSorting = { indicator: false };

    } else {
      cellMeta.multiColumnSorting = Object.assign(storedColumnProperties, pluginMainSettings, pluginColumnConfig);
    }
  }

  /**
   * Get settings for first physical cell in the column for purpose of workaround (cell meta isn't merged properly).
   *
   * @private
   * @param {Number} column Visual column index.
   * @returns {Object}
   */
  getFirstCellSettings(column) {
    this.blockPluginTranslation = true;

    if (this.readCellMetaFromCache === false) {
      const numberOfColumns = this.hot.countCols();

      rangeEach(numberOfColumns, (visualColumnIndex) => this.overwriteFirstCellSettings(visualColumnIndex));

      this.readCellMetaFromCache = true;
    }

    const cellMeta = this.hot.getCellMeta(0, column);

    this.blockPluginTranslation = false;

    return cellMeta;
  }

  /**
   * Get number of rows which should be sorted.
   *
   * @private
   * @param {Number} numberOfRows Total number of displayed rows.
   * @returns {Number}
   */
  getNumberOfRowsToSort(numberOfRows) {
    const settings = this.hot.getSettings();

    // `maxRows` option doesn't take into account `minSpareRows` option in specific situation.
    if (settings.maxRows <= numberOfRows) {
      return settings.maxRows;
    }

    return numberOfRows - settings.minSpareRows;
  }

  /**
   * Performs the sorting using a stable sort function basing on internal state of sorting.
   *
   * @private
   */
  sortByPresetSortState() {
    if (this.columnStatesManager.isListOfSortedColumnsEmpty()) {
      this.rowsMapper.clearMap();

      return;
    }

    const indexesWithData = [];
    const sortedColumnsList = this.columnStatesManager.getSortedColumns();
    const numberOfRows = this.hot.countRows();

    // Function `getDataAtCell` won't call the indices translation inside `onModifyRow` listener - we check the `blockPluginTranslation`
    // flag inside (we just want to get data not already modified by `multiColumnSorting` plugin translation).
    this.blockPluginTranslation = true;

    const getDataForSortedColumns = (visualRowIndex) =>
      arrayMap(sortedColumnsList, (physicalColumn) => this.hot.getDataAtCell(visualRowIndex, this.hot.toVisualColumn(physicalColumn)));

    for (let visualRowIndex = 0; visualRowIndex < this.getNumberOfRowsToSort(numberOfRows); visualRowIndex += 1) {
      indexesWithData.push([visualRowIndex].concat(getDataForSortedColumns(visualRowIndex)));
    }

    mergeSort(indexesWithData, mainSortComparator(
      arrayMap(sortedColumnsList, (physicalColumn) => this.columnStatesManager.getSortOrderOfColumn(physicalColumn)),
      arrayMap(sortedColumnsList, (physicalColumn) => this.getFirstCellSettings(this.hot.toVisualColumn(physicalColumn)))
    ));

    // Append spareRows
    for (let visualRowIndex = indexesWithData.length; visualRowIndex < numberOfRows; visualRowIndex += 1) {
      indexesWithData.push([visualRowIndex].concat(getDataForSortedColumns(visualRowIndex)));
    }

    // The blockade of the indices translation is released.
    this.blockPluginTranslation = false;

    // Save all indexes to arrayMapper, a completely new sequence is set by the plugin
    this.rowsMapper._arrayMap = arrayMap(indexesWithData, (indexWithData) => indexWithData[0]);
  }

  /**
   * `modifyRow` hook callback. Translates visual row index to the sorted row index.
   *
   * @private
   * @param {Number} row Visual row index.
   * @returns {Number} Physical row index.
   */
  onModifyRow(row, source) {
    if (this.blockPluginTranslation === false && source !== this.pluginName) {
      let rowInMapper = this.rowsMapper.getValueByIndex(row);
      row = rowInMapper === null ? row : rowInMapper;
    }

    return row;
  }

  /**
   * Translates sorted row index to visual row index.
   *
   * @private
   * @param {Number} row Physical row index.
   * @returns {Number} Visual row index.
   */
  onUnmodifyRow(row, source) {
    if (this.blockPluginTranslation === false && source !== this.pluginName) {
      row = this.rowsMapper.getIndexByValue(row);
    }

    return row;
  }

  /**
   * `onAfterGetColHeader` callback. Adds column sorting css classes to clickable headers.
   *
   * @private
   * @param {Number} column Visual column index.
   * @param {Element} TH TH HTML element.
   */
  onAfterGetColHeader(column, TH) {
    if (column < 0 || !TH.parentNode) {
      return;
    }

    const headerLink = TH.querySelector(`.${HEADER_CLASS}`);

    if (isUndefined(headerLink) || this.enabled === false) {
      return;
    }

    const TRs = TH.parentNode.parentNode.childNodes;
    const headerLevel = Array.from(TRs).indexOf(TH.parentNode) - TRs.length;

    if (headerLevel !== -1) {
      return;
    }

    const pluginSettingsForColumn = this.getFirstCellSettings(column).multiColumnSorting;

    const physicalColumn = this.hot.toPhysicalColumn(column);
    const showSortIndicator = pluginSettingsForColumn.indicator;
    const headerActionEnabled = pluginSettingsForColumn.headerAction;

    removeClass(headerLink, this.domHelper.getRemovedClasses(headerLink));
    addClass(headerLink, this.domHelper.getAddedClasses(physicalColumn, showSortIndicator, headerActionEnabled));
  }

  /**
   * afterUpdateSettings callback.
   *
   * @private
   * @param {Object} settings New settings object.
   */
  onAfterUpdateSettings(settings) {
    warnIfPluginsHasConflict(settings.columnSorting);

    this.readCellMetaFromCache = false;

    if (isDefined(settings.multiColumnSorting)) {
      this.sortBySettings(settings.multiColumnSorting);
    }
  }

  /**
   * Load saved settings or sort by predefined plugin configuration.
   *
   * @private
   */
  loadOrSortBySettings() {
    this.readCellMetaFromCache = false;

    const storedAllSortSettings = this.getAllSavedSortSettings();

    if (isObject(storedAllSortSettings)) {
      this.sortBySettings(storedAllSortSettings);

    } else {
      const allSortSettings = this.hot.getSettings().multiColumnSorting;

      this.sortBySettings(allSortSettings);
    }
  }

  /**
   * Sort the table by provided configuration. Get all sort config settings. Object contains `initialConfig`, `indicator`,
   * `sortEmptyCells` and `compareFunctionFactory` properties.
   *
   * @private
   * @param {Object} allSortSettings
   */
  sortBySettings(allSortSettings) {
    if (isObject(allSortSettings)) {
      this.columnStatesManager.updateAllColumnsProperties(allSortSettings);

      const initialConfig = allSortSettings.initialConfig;

      if (Array.isArray(initialConfig)) {
        this.sort(initialConfig);
      }
    }

    // It render the table after merging settings. The `AutoColumnSize` plugin will count the table width properly after that.
    this.hot._registerTimeout(setTimeout(() => {
      this.hot.render();

      // When option `rowHeaders` is set to `true` the table doesn't look properly.
      this.hot.view.wt.wtOverlays.adjustElementsSize(true);
    }));
  }

  /**
   * `afterCreateRow` callback. Updates the sort state after a row have been created.
   *
   * @private
   * @param {Number} index Visual index of the created row.
   * @param {Number} amount Amount of created rows.
   */
  onAfterCreateRow(index, amount) {
    this.rowsMapper.shiftItems(index, amount);
  }

  /**
   * `afterRemoveRow` hook callback.
   *
   * @private
   * @param {Number} removedRows Visual indexes of the removed row.
   * @param {Number} amount  Amount of removed rows.
   */
  onAfterRemoveRow(removedRows, amount) {
    this.rowsMapper.unshiftItems(removedRows, amount);
  }

  /**
   * Indicates if clickable header was clicked.
   *
   * @param {MouseEvent} event
   * @param {Number} column Visual column index.
   * @returns {Boolean}
   */
  wasClickableHeaderClicked(event, column) {
    const headerActionEnabled = this.getFirstCellSettings(column).multiColumnSorting.headerAction;

    if (headerActionEnabled && event.realTarget.nodeName === 'SPAN') {
      return true;
    }

    return false;
  }

  /**
   * Changes the behavior of selection / dragging.
   *
   * @private
   * @param {MouseEvent} event
   * @param {CellCoords} coords Visual coordinates.
   * @param {HTMLElement} TD
   * @param {Object} blockCalculations
   */
  beforeOnCellMouseDown(event, coords, TD, blockCalculations) {
    if (this.wasClickableHeaderClicked(event, coords.col) && isPressedCtrlKey()) {
      blockCalculations.column = true;
    }
  }

  /**
   * `onAfterOnCellMouseDown` hook callback.
   *
   * @private
   * @param {Event} event Event which are provided by hook.
   * @param {CellCoords} coords Visual coords of the selected cell.
   */
  onAfterOnCellMouseDown(event, coords) {
    if (coords.row >= 0) {
      return;
    }

    // Click on the header
    if (this.wasClickableHeaderClicked(event, coords.col)) {
      if (isPressedCtrlKey()) {
        this.hot.deselectCell();
        this.hot.selectColumns(coords.col);

        this.sort(this.getNextSortConfig(coords.col, APPEND_COLUMN_CONFIG_STRATEGY));

      } else {
        this.sort(this.getColumnNextConfig(coords.col));
      }
    }
  }

  /**
   * Destroys the plugin instance.
   */
  destroy() {
    this.rowsMapper.destroy();
    this.domHelper.destroy();
    this.columnStatesManager.destroy();

    super.destroy();
  }
}

registerPlugin('multiColumnSorting', MultiColumnSorting);

export default MultiColumnSorting;
