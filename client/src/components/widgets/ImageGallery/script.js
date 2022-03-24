import Plotly from 'plotly.js-basic-dist-min';
import { isNil, isEqual } from 'lodash';
import { mapGetters, mapActions, mapMutations } from 'vuex';
import { decode } from '@msgpack/msgpack';
import { setAxesStyling, scalarBarAutoLayout } from '../../../utils/vtkPlotStyling';

// Load the rendering pieces we want to use (for both WebGL and WebGPU)
import '@kitware/vtk.js/Rendering/Profiles/Geometry';

import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkColorMaps from '@kitware/vtk.js/Rendering/Core/ColorTransferFunction/ColorMaps';
import vtkColorTransferFunction from '@kitware/vtk.js/Rendering/Core/ColorTransferFunction';
import vtkCubeAxesActor from '@kitware/vtk.js/Rendering/Core/CubeAxesActor';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkPointPicker from '@kitware/vtk.js/Rendering/Core/PointPicker';
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';
import vtkRenderer from '@kitware/vtk.js/Rendering/Core/Renderer';
import vtkScalarBarActor from '@kitware/vtk.js/Rendering/Core/ScalarBarActor';
import vtkCornerAnnotation from '@kitware/vtk.js/Interaction/UI/CornerAnnotation';

//-----------------------------------------------------------------------------
// Utility Functions
//-----------------------------------------------------------------------------
function parseZoomValues(data, globalY) {
  if (data['xaxis.autorange'] || data['yaxis.autorange']) {
    return
  }

  const zoomLevel = {
    xAxis: [data['xaxis.range[0]'], data['xaxis.range[1]']],
    yAxis: [data['yaxis.range[0]'], data['yaxis.range[1]']]
  }
  if (globalY) {
    zoomLevel.yAxis = globalY;
  }
  return zoomLevel;
}

function addAnnotations(data, zoom, yRange) {
  if (!zoom) {
    return
  }

  const xRange = [data.x[0], data.x[data.x.length-1]];
  if (!yRange)
    yRange = [Math.min(...data.y), Math.max(...data.y)];
  const rangeText = (
    `<b>
      X: [${xRange[0].toPrecision(4)}, ${xRange[1].toPrecision(4)}]
      Y: [${yRange[0].toPrecision(4)}, ${yRange[1].toPrecision(4)}]
    </b>`
  )

  const annotations = [{
    xref: 'paper',
    yref: 'paper',
    x: 0,
    xanchor: 'left',
    y: 1,
    yanchor: 'bottom',
    text: rangeText,
    showarrow: false
  }]
  return annotations;
}

export default {
  name: "plotly",

  props: {
    maxTimeStep: {
      type: Number,
      required: true
    },
  },

  inject: ['girderRest', 'fastRestUrl'],

  data() {
    return {
      itemId: null,
      loadedImages: [],
      pendingImages: 0,
      rows: [],
      json: true,
      image: null,
      eventHandlersSet: false,
      loadedFromView: false,
      zoom: null,
      xaxis: null,
      selectedTimeStep: 0,
      renderer: null,
      cells: [],
      mesh: null,
      mapper: null,
      actor: null,
      axes: null,
      scalarBar: null,
      availableTimeSteps: [],
      currentAvailableStep: 1,
      times: null,
      timeIndex: -1,
      inThisRenderer: false,
      startPoints: null,
      cornerAnnotation: null,
      camera: null,
      focalPoint: null,
      scale: 0,
      position: null,
    };
  },

  asyncComputed: {
    ...mapGetters({
      currentTimeStep: 'PLOT_TIME_STEP',
      globalRanges: 'PLOT_GLOBAL_RANGES',
      globalZoom: 'PLOT_ZOOM',
      numcols: 'VIEW_COLUMNS',
      numrows: 'VIEW_ROWS',
      renderWindow: 'UI_RENDER_WINDOW',
      syncZoom: 'UI_ZOOM_SYNC',
      zoomAxis: 'PLOT_ZOOM_X_AXIS',
      timeStepSelectorMode: 'UI_TIME_STEP_SELECTOR',
      initialLoad: 'PLOT_INITIAL_LOAD',
      minTimeStep: 'PLOT_MIN_TIME_STEP',
      interactor: 'UI_INTERACTOR',
      boxSelector: 'PLOT_BOX_SELECTOR',
      globalFocalPoint: 'PLOT_FOCAL_POINT',
      globalScale: 'PLOT_SCALE',
    }),

    rows: {
      default: [],
      async get() {
        if (!this.itemId) {
          return [];
        }

        if (this.rows.length == 0) {
          this.loadImage();
        }
        return this.rows;
      },
    },

    zoomLevels() {
      var zoom = this.zoom;
      if (this.syncZoom && this.globalZoom && this.xaxis === this.zoomAxis)
        zoom = this.globalZoom;
      return zoom;
    }
  },

  watch: {
    currentTimeStep: {
      immediate: true,
      handler () {
        this.preCacheImages();
      }
    },
    itemId: {
      immediate: true,
      handler () {
        this.rows = [];
        this.loadedImages = [];
      }
    },
    maxTimeStep: {
      immediate: true,
      handler () {
        this.loadImage();
      }
    },
    numrows: {
      immediate: true,
      handler() {
        this.react();
        this.$nextTick(this.updateViewPort);
      }
    },
    numcols: {
      immediate: true,
      handler() {
        this.react();
        this.$nextTick(this.updateViewPort);
      }
    },
    globalRanges: {
      handler() {
        this.react();
      },
      deep: true,
      immediate: true,
    },
    zoomLevels: {
      immediate: true,
      handler() {
        this.react();
      }
    },
    focalPoint(fp) {
      if (!this.renderer || !fp) {
        return;
      }
      this.camera.setFocalPoint(...fp);
      this.camera.setParallelProjection(true);
      this.camera.zoom(this.scale);
    },
    globalFocalPoint(fp) {
      this.focalPoint = fp;
    },
    globalScale(scale) {
      this.scale = scale;
    }
  },

  methods: {
    ...mapActions({
      setZoomDetails: 'PLOT_ZOOM_DETAILS',
      updateZoom: 'PLOT_ZOOM_VALUES_UPDATED',
      setMinTimeStep: 'PLOT_MIN_TIME_STEP_CHANGED',
    }),
    ...mapMutations({
      setTimeStep: 'PLOT_TIME_STEP_SET',
      setZoomOrigin: 'PLOT_ZOOM_ORIGIN_SET',
      updateCellCount: 'PLOT_VISIBLE_CELL_COUNT_SET',
      setMaxTimeStep: 'PLOT_MAX_TIME_STEP_SET',
      setItemId: 'PLOT_CURRENT_ITEM_ID_SET',
      setLoadedFromView: 'PLOT_LOADED_FROM_VIEW_SET',
      setInitialLoad: 'PLOT_INITIAL_LOAD_SET',
      updateRendererCount: 'UI_RENDERER_COUNT_SET',
      setPauseGallery: 'UI_PAUSE_GALLERY_SET',
      setGlobalFocalPoint: 'PLOT_FOCAL_POINT_SET',
      setGlobalScale: 'PLOT_SCALE_SET',
    }),

    resize() {
      Plotly.relayout(this.$refs.plotly, {
        'xaxis.autorange': true,
        'yaxis.autorange': true
      });
    },

    preventDefault: function (event) {
      event.preventDefault();
    },

    callEndpoint: async function (endpoint) {
      const { data } = await this.girderRest.get(endpoint);
      return data;
    },

    callFastEndpoint: async function (endpoint, options=null) {
      const { data } = await this.girderRest.get(
        `${this.fastRestUrl}/${endpoint}`, options ? options : {});
      return data;
    },

    fetchImage: async function(timeStep) {
      var plotType = 'vtk';
      let img = await this.callFastEndpoint(`variables/${this.itemId}/timesteps/${timeStep}/plot`, {responseType: 'blob'})
        .then((response) => {
          const reader = new FileReader();
          if (response.type === 'application/msgpack') {
            reader.readAsArrayBuffer(response);
          } else {
            reader.readAsText(response);
            plotType = 'plotly';
          }
          return new Promise(resolve => {
            reader.onload = () => {
              if (plotType === 'vtk') {
                const img = decode(reader.result);
                Plotly.purge(this.$refs.plotly);
                this.addRenderer(img);
                this.loadedImages.push({
                  timestep: timeStep,
                  data: img,
                  type: plotType
                });
                return resolve(img);
              } else {
                const img = JSON.parse(reader.result);
                this.loadedImages.push({
                  timestep: timeStep,
                  data: img.data,
                  layout: img.layout,
                  type: plotType,
                });
                return resolve(img);
              }
            };
          });
        });
      return {plotType, img};
    },
    loadImage: async function() {
      if (!this.itemId) {
        return;
      }
      const firstAvailableStep = await this.callFastEndpoint(`variables/${this.itemId}/timesteps`)
        .then((response) => {
          this.availableTimeSteps = response.steps.sort();
          this.times = response.time;
          this.setMinTimeStep(
            Math.max(this.minTimeStep, Math.min(...this.availableTimeSteps)));
          // Make sure there is an image associated with this time step
          let step = this.availableTimeSteps.find(
            step => step === this.currentTimeStep);
          if (isNil(step)) {
            // If not, display the previous available image
            // If no previous image display first available
            let idx = this.availableTimeSteps.findIndex(
              step => step > this.currentTimeStep);
            idx = Math.max(idx-1, 0);
            step = this.availableTimeSteps[idx];
          }
          return step;
        });
      const {plotType, img} = await this.fetchImage(firstAvailableStep);
      this.rows[0] = {'img': img, 'step': firstAvailableStep, 'type': plotType};

      this.setMaxTimeStep(Math.max(this.maxTimeStep, Math.max(...this.availableTimeSteps)));
      this.setItemId(this.itemId);
      this.setInitialLoad(false);

      this.react();

      this.preCacheImages();
    },
    loadGallery: function (event) {
      event.preventDefault();
      this.zoom = null
      var items = JSON.parse(event.dataTransfer.getData('application/x-girder-items'));
      this.itemId = items[0]._id;
      this.setLoadedFromView(false);
      this.removeRenderer();
      this.$root.$children[0].$emit('item-added', this.itemId);
    },
    loadTemplateGallery: function (item) {
      this.itemId = item.id;
      this.zoom = item.zoom;
      this.setLoadedFromView(true);
      this.removeRenderer();
    },
    preCacheImages: async function () {
      const numTimeSteps = this.availableTimeSteps.length;
      if (!numTimeSteps) {
        // We have not selected an item, do not attempt to load the images
        return;
      }
      // Load the next three images.
      for (var i = 0; i < 3; i++) {
        this.currentAvailableStep += i;
        if (i > this.maxTimeStep || this.currentAvailableStep >= numTimeSteps) {
          // There are no more images to load
          break;
        }
        // Only load this image we haven't done so already.
        let nextStep = this.availableTimeSteps[this.currentAvailableStep];
        let idx = this.rows.findIndex(image => image.step === nextStep);
        if (idx < 0) {
          const {plotType, img} = await this.fetchImage(nextStep);
          this.rows.push({'img': img, 'step': nextStep, 'type': plotType});
        }
      }
      this.react()
    },
    react: function () {
      let nextImage = this.loadedImages.find(img => img.timestep == this.currentTimeStep);
      if (isNil(nextImage) && this.loadedImages.length == 1)
        nextImage = this.loadedImages[0];

      if (!isNil(nextImage)) {
        if (nextImage.type === 'plotly') {
          if (!this.xaxis) {
            this.xaxis = nextImage.layout.xaxis.title.text;
          }

          nextImage.layout.yaxis.autorange = true;
          if (this.zoomLevels) {
            nextImage.layout.xaxis.range = this.zoomLevels.xAxis;
            nextImage.layout.yaxis.range = this.zoomLevels.yAxis;
            nextImage.layout.yaxis.autorange = false;
          }
          var range = null;
          if (this.itemId in this.globalRanges) {
            range = this.globalRanges[`${this.itemId}`];
            if (range) {
              nextImage.layout.yaxis.range = [...range];
              nextImage.layout.yaxis.autorange = false;
            }
          }
          nextImage.layout['annotations'] = addAnnotations(nextImage.data[0], this.zoomLevels, range);
          Plotly.react(this.$refs.plotly, nextImage.data, nextImage.layout, {autosize: true});
          if (!this.eventHandlersSet)
            this.setEventHandlers();
          this.json = true;
        } else {
          if (!this.xaxis) {
            this.xaxis = nextImage.data.xLabel;
          }
          this.updateRenderer(nextImage.data);
        }
      }
      this.$parent.$parent.$parent.$parent.$emit("gallery-ready");
    },
    async fetchMovie(e) {
      const response = await this.callEndpoint(`item/${this.itemId}`);
      const data = {
        id: this.itemId,
        name: response.name,
        event: e,
        isJson: this.json,
      }
      this.$parent.$parent.$parent.$parent.$emit("param-selected", data);
    },
    clearGallery() {
      this.itemId = null;
      this.pendingImages = 0;
      this.json = true;
      this.image = null;
      this.setInitialLoad(true);
    },
    setEventHandlers() {
      this.$refs.plotly.on('plotly_relayout', (eventdata) => {
        this.zoom = parseZoomValues(eventdata, this.globalRanges[this.itemId]);
        if (!this.zoomOrigin) {
          this.setZoomOrigin(this.itemId);
        }
        if (this.syncZoom && this.itemId !== this.zoomOrigin) {
          this.setZoomDetails({zoom: this.zoom, xAxis: this.xaxis});
        }
        this.react();
      });
      this.$refs.plotly.on('plotly_click', (data) => {
        this.findClosestTime(parseFloat(data.points[0].x));
      });
      this.$refs.plotly.on('plotly_doubleclick', () => {
        const xAxis = this.xaxis.split(' ')[0].toLowerCase();
        if (this.timeStepSelectorMode && xAxis === 'time') {
          this.selectTimeStepFromPlot();
          return false;
        } else {
          this.zoom = null;
          if (this.syncZoom) {
            this.setZoomDetails({zoom: null, xAxis: null});
          }
        }
      });
      this.eventHandlersSet = true;
    },
    updateViewPort() {
      if (!this.renderer)
        return

      const parent = this.$parent.$el.getBoundingClientRect();
      const { x, y, width, height } = this.$el.getBoundingClientRect();
      const viewport = [
        (x - parent.x) / parent.width,
        1 - (y + height) / parent.height,
        ((x - parent.x) + width) / parent.width,
        1 - y / parent.height,
      ];
      this.renderer.setViewport(...viewport);
    },
    addRenderer(data) {
      if (this.renderer)
        return
      // Create the building blocks we will need for the polydata
      this.renderer = vtkRenderer.newInstance({background: [1, 1, 1]});
      this.mesh = vtkPolyData.newInstance();
      this.actor = vtkActor.newInstance();
      this.mapper = vtkMapper.newInstance();

      // Load the cell attributes
      // Create a view of the data
      const connectivityView = new DataView(data.connectivity.buffer, data.connectivity.byteOffset,  data.connectivity.byteLength);
      const numberOfNodes = data.connectivity.length / Int32Array.BYTES_PER_ELEMENT / 3;
      this.cells = new Int32Array(numberOfNodes * 4);
      var idx = 0;
      const rowSize = 3 * Int32Array.BYTES_PER_ELEMENT; // 3 => columns
      for (let i = 0; i < data.connectivity.length; i+=rowSize) {
        this.cells[idx++] = 3;
        let index = i
        this.cells[idx++] = connectivityView.getInt32(index, true);
        index += 4
        this.cells[idx++] = connectivityView.getInt32(index, true);
        index += 4
        this.cells[idx++] = connectivityView.getInt32(index, true);
      }
      this.mesh.getPolys().setData(this.cells);

      // Setup colormap
      const lut = vtkColorTransferFunction.newInstance();
      lut.applyColorMap(vtkColorMaps.getPresetByName('jet'));

      // Setup mapper and actor
      this.mapper.setInputData(this.mesh);
      this.mapper.setLookupTable(lut);
      this.actor.setMapper(this.mapper);
      this.renderer.addActor(this.actor);

      // Update renderer window
      this.camera = this.renderer.getActiveCamera();
      this.camera.setParallelProjection(true);

      // Create axis
      this.axes = vtkCubeAxesActor.newInstance();
      this.axes.setCamera(this.camera);
      this.axes.setAxisLabels(data.xLabel, data.yLabel, '');
      this.axes.getGridActor().getProperty().setColor('black');
      this.axes.getGridActor().getProperty().setLineWidth(0.1);
      this.renderer.addActor(this.axes);

      // Build color bar
      this.scalarBar = vtkScalarBarActor.newInstance();
      this.scalarBar.setScalarsToColors(lut);
      this.scalarBar.setAxisLabel(data.colorLabel);
      this.scalarBar.setAxisTextStyle({fontColor: 'black'});
      this.scalarBar.setTickTextStyle({fontColor: 'black'});
      this.scalarBar.setDrawNanAnnotation(false);
      this.renderer.addActor2D(this.scalarBar);

      // Setup picker
      this.setupPointPicker();

      // Add corner annotation
      this.cornerAnnotation = vtkCornerAnnotation.newInstance();

      this.$nextTick(this.updateViewPort);
      this.renderWindow.addRenderer(this.renderer);
      this.updateRendererCount(this.renderWindow.getRenderers().length);
    },
    updateRenderer(data) {
      // Load the point attributes
      // Create a view of the data
      const pointsView = new DataView(data.nodes.buffer, data.nodes.byteOffset,  data.nodes.byteLength);
      const numberOfPoints = data.nodes.length / Float64Array.BYTES_PER_ELEMENT / 2;
      const points = new Float64Array(numberOfPoints * 3);
      var idx = 0;
      const rowSize = 2 * Float64Array.BYTES_PER_ELEMENT; // 3 => columns
      for (let i = 0; i < data.nodes.length; i+=rowSize) {
        points[idx++] = pointsView.getFloat64(i, true);
        points[idx++] = pointsView.getFloat64(i + 8, true);
        points[idx++] = 0.0;
      }

      // Set the scalars
      // As we need a typed array we have to copy the data as its unaligned, so we have an aligned buffer to
      // use to create the typed array
      const buffer = data.color.buffer.slice(data.color.byteOffset, data.color.byteOffset + data.color.byteLength)
      const color = new Float64Array(buffer, 0, buffer.byteLength / Float64Array.BYTES_PER_ELEMENT)
      const scalars = vtkDataArray.newInstance({
        name: 'scalars',
        values: color,
      });

      // Build the polydata
      this.mesh.getPoints().setData(points, 3);
      this.mesh.getPointData().setScalars(scalars);

      // Setup colormap
      const lut = this.mapper.getLookupTable();
      lut.setMappingRange(...scalars.getRange());
      lut.updateRange();

      // Setup mapper and actor
      this.mapper.setInputData(this.mesh);
      this.mapper.setScalarRange(...scalars.getRange());

      // Update axes
      this.axes.setDataBounds(this.actor.getBounds());
      const { faces, edges, ticks, labels } = setAxesStyling(this.axes);
      this.axes.updateTextData(faces, edges, ticks, labels);

      // Update color bar
      this.scalarBar.setScalarsToColors(lut);
      this.scalarBar.setAutoLayout(scalarBarAutoLayout(this.scalarBar));

      // Update camera
      this.camera.setParallelProjection(true);
      if (!this.focalPoint && !this.scale) {
        this.renderer.resetCamera();
        if (!this.position) {
          this.position = this.camera.getPosition();
        }
      }
    },
    removeRenderer() {
      if (this.renderer) {
        this.renderWindow.removeRenderer(this.renderer);
        this.renderer = null;
        this.updateRendererCount(this.renderWindow.getRenderers().length);
        this.position = null;
      }
    },
    enterCurrentRenderer() {
      if(this.renderer) {
        this.interactor.setCurrentRenderer(this.renderer);
      }
    },
    exitCurrentRenderer() {
      if (this.renderer) {
        this.interactor.setCurrentRenderer(null);
      }
    },
    setupPointPicker() {
      const picker = vtkPointPicker.newInstance();
      picker.setPickFromList(1);
      picker.initializePickList();
      picker.addPickList(this.actor);
      this.interactor.onLeftButtonPress((callData) => {
        this.timeIndex = -1;
        const xAxis = this.xaxis.split(' ')[0].toLowerCase();
        this.inThisRenderer = this.renderer === callData.pokedRenderer;
        if (!this.inThisRenderer) {
          return;
        }
        const pos = callData.position;
        const point = [pos.x, pos.y, 0.0];
        picker.pick(point, this.renderer);
        if (picker.getActors().length !== 0) {
          const pickedPoints = picker.getPickedPositions();
          this.startPoints = pickedPoints;
          if (this.timeStepSelectorMode && xAxis === 'time') {
            this.findClosestTime(pickedPoints[0]);
          }
        }
      });
      this.interactor.onLeftButtonRelease((callData) => {
        this.timeIndex = -1;
        this.inThisRenderer = this.renderer === callData.pokedRenderer;
        if (!this.inThisRenderer && !this.syncZoom) {
          return;
        }
        const pos = callData.position;
        const point = [pos.x, pos.y, 0.0];
        picker.pick(point, this.renderer);
        if (picker.getActors().length !== 0 && this.startPoints) {
          const pickedPoints = picker.getPickedPositions();
          if (isEqual(pickedPoints, this.startPoints)) {
            // This was just a single click
            return;
          }
          const xMid = ((pickedPoints[0][0] - this.startPoints[0][0]) / 2) + this.startPoints[0][0];
          const yMid = ((pickedPoints[0][1] - this.startPoints[0][1]) / 2) + this.startPoints[0][1];
          if (this.syncZoom) {
            this.setGlobalFocalPoint([xMid, yMid, 0.0]);
          } else {
            this.focalPoint = [xMid, yMid, 0.0]
          }
        }
      });
      this.boxSelector.onBoxSelectChange((data) => {
        if (!this.inThisRenderer && !this.syncZoom) {
          return;
        }
        const { selection, view } = data;
        const [x1, y1, ] = view.displayToNormalizedDisplay(selection[0], selection[2], selection[4]);
        const [x2, y2, ] = view.displayToNormalizedDisplay(selection[1], selection[3], selection[5]);
        const bounds = this.renderer.computeVisiblePropBounds();
        const x = (bounds[1] - bounds[0]) / 2;
        const y = (bounds[3] - bounds[2]) / 2;
        const w = (x2 - x1) / 2;
        const h = (y2 - y1) / 2;
        const r = w / h;
        if (r >= x / y) {
          this.scale = y + 1;
        } else {
          this.scale = x / r + 1;
        }
        // Update corner annotation
        this.cornerAnnotation.setContainer(this.$refs.plotly);
        this.cornerAnnotation.updateMetadata({range: this.actor.getBounds()});
        this.cornerAnnotation.updateTemplates({
          nw(meta) {
            return `xRange: [${meta.range.slice(0,2)}] yRange: [${meta.range.slice(2,4)}]`;
          },
        });
        if (this.syncZoom) {
          this.setGlobalScale(this.scale);
        }
      });
    },
    selectTimeStepFromPlot() {
      if (this.timeIndex >= 0) {
        this.setTimeStep(this.availableTimeSteps[this.timeIndex]);
        this.timeIndex = -1;
        this.setPauseGallery(true);
      } else {
        this.resetZoom();
      }
    },
    resetZoom() {
      this.focalPoint = null;
      this.scale = 0;
      if (this.syncZoom) {
        this.setGlobalFocalPoint(this.focalPoint);
        this.setGlobalScale(this.scale);
      }
      this.cornerAnnotation.setContainer(null);
      this.camera.setParallelProjection(true);
      this.camera.setPosition(...this.position);
      this.renderer.resetCamera();
    },
    findClosestTime(value) {
      // Time is stored as seconds but plotted as milliseconds
      const pickedPoint = value * 0.001;
      var closestVal = -Infinity;
      this.times.forEach((time) => {
        // Find the closest time at or before the selected time
        const newDiff = pickedPoint - time;
        const oldDiff = pickedPoint - closestVal;
        if (newDiff >= 0 && newDiff < oldDiff) {
          closestVal = time;
        }
      });
      this.timeIndex = this.times.findIndex(time => time === closestVal);
    }
  },

  mounted () {
    this.updateCellCount(1);
    this.$el.addEventListener('mouseenter', this.enterCurrentRenderer);
    this.$el.addEventListener('mouseleave', this.exitCurrentRenderer);
    this.$el.addEventListener('dblclick', this.selectTimeStepFromPlot);
    window.addEventListener('resize', this.resize);
  },

  destroyed() {
    this.updateCellCount(-1);
    if (this.renderer) {
      this.renderWindow.removeRenderer(this.renderer);
      this.updateRendererCount(this.renderWindow.getRenderers().length);
    }
  }
};
