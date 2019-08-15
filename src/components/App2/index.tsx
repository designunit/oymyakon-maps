import * as React from 'react'
import { ViewState } from 'react-map-gl'
import { omit } from 'lodash'
import { AppMap } from '../AppMap'
import { AppHeader } from '../AppHeader'
import { Container } from './Container'
import { CaseTree } from './CaseTree'
import { FeatureMarkerLayer } from '../FeatureMarkerLayer'
import { FeatureCollection, Point, Feature, Geometry } from 'geojson'
import { IFeatureProperties, ILayer, UserFeature, IUserFeatureProperties, IFeatureIndex, FeatureId, IUserFeatureSchema } from '../../app/types'
import { Button, Select, Drawer, Spin, Icon, Switch, Modal, Dropdown, Menu, Upload, message } from 'antd'
import { createFeatureInLocation, deleteFeatureId, updateFeature, createLayer, deleteLayer, updateLayer, createFeatureInLocationAndAssignToLayer, changeFeatureLayer, removeFeatureFromLayer, uploadGeojsonFeaturesIntoNewLayer } from '../../app/api'
import { filterFeatures, replaceFeatureWithProperties, updateFeaturePointLocation, addFeature, createGeojson, changeFeatureProperties } from '../../lib/geojson'
import { makeUnique } from '../../lib/text'
import { Json } from '../Json'
import { createFeatureCaseFilter, createFeatureUserFilter } from './lib'
import { download } from '../../lib/download'

import '../../style.css'
import { LayerPanel } from '../LayerPanel'
import { FeatureAttributesEditor } from '../FeatureAttributesEditor';
import { sleep } from '../../lib/time';
import { EditLayerModal } from '../EditLayerModal'
import { ActionButton } from '../ActionButton'
import { UserFeatureEditor } from '../UserFeatureEditor'
import { createPinTextFunction, createMarkerColorFunction, createFilterConfig, getSchemaFilterKeys } from '../../app/layerSchema';
import { FeatureFilter } from '../FeatureFilter';

type FC = FeatureCollection<Point, IFeatureProperties>
const ADD_FEATURE_TOOL = 'ADD_FEATURE_TOOL'
const MOVE_FEATURE_TOOL = 'MOVE_FEATURE_TOOL'

const ACTION_LAYER_ADD = 'ACTION_LAYER_ADD'
const ACTION_LAYER_DELETE = 'ACTION_LAYER_DELETE'
const ACTION_LAYER_SET = 'ACTION_LAYER_SET'
const ACTION_FEATURE_DELETE = 'ACTION_FEATURE_DELETE'
const ACTION_FEATURE_SET = 'ACTION_FEATURE_SET'
const ACTION_FEATURE_SET_PROPERTY = 'ACTION_FEATURE_SET_PROPERTY'
const ACTION_FEATURE_SET_PROPERTIES = 'ACTION_FEATURE_SET_PROPERTIES'
const ACTION_LAYER_FILTER_TREE_SET_CHECKED_KEYS = 'ACTION_LAYER_FILTER_TREE_SET_CHECKED_KEYS'

export interface IMapViewport extends ViewState {
    transitionDuration?: number
}

export interface IAppProps {
    mapboxToken: string
    center: [number, number]
    zoom: number
    userLayers: ILayer[]
    featureIndex: IFeatureIndex<any, Point>
    defaultCheckedCaseKeys: string[]
    drawerPlacement: 'right' | 'left' | 'bottom' | 'top'
    mapStyle: string
    mapStyleOption: string
    mapStyleOptions: { value: string, name: string }[]
    onChangeMapStyleOption: (value: string) => void
}

function selectFeatures<T, G extends Geometry = Geometry>(featureIndex: IFeatureIndex<T, G>, featureIds: FeatureId[] = [], filter: (feature: Feature<G, T>) => boolean): FeatureCollection<G, T> {
    // const features = featureIds
    //     .map(id => featureIndex[id])
    //     .filter(Boolean)
    const features = featureIds.reduce((fs, id) => {
        const feature = featureIndex[id]
        if (feature && filter(feature)) {
            fs.push(feature)
        }
        return fs
    }, [])
    return createGeojson(features)
}

function layerFilterTreeReducer(state: any, action) {
    if (action.type === ACTION_LAYER_FILTER_TREE_SET_CHECKED_KEYS) {
        const id = action.payload.layerId
        return {
            ...state,
            [id]: action.payload.checkedKeys,
        }
    }

    return state
}

function featuresIndexReducer(state: any, action) {
    if (action.type === ACTION_FEATURE_SET) {
        const feature: UserFeature = action.payload
        return {
            ...state,
            [feature.id]: feature,
        }
    }

    if (action.type === ACTION_FEATURE_DELETE) {
        const featureId: FeatureId = action.payload.featureId
        const newState = {
            ...state,
        }
        delete newState[featureId]
        return newState
    }

    if (action.type === ACTION_FEATURE_SET_PROPERTY) {
        const featureId: number = action.payload.featureId
        const key: string = action.payload.key
        const value: string = action.payload.value
        const feature = state[featureId]

        return {
            ...state,
            [featureId]: changeFeatureProperties(feature, {
                ...feature.properties,
                [key]: value,
            }),
        }
    }

    if (action.type === ACTION_FEATURE_SET_PROPERTIES) {
        const featureId: number = action.payload.featureId
        const properties: { [name: string]: any } = action.payload.properties
        const feature = state[featureId]

        return {
            ...state,
            [featureId]: changeFeatureProperties(feature, {
                ...feature.properties,
                ...properties,
            }),
        }
    }

    return state
}

type LayerAction = {
    type: string,
    // payload: ILayer | Partial<ILayer>
    payload: any
}

function layersReducer(state: ILayer[], action: LayerAction): ILayer[] {
    if (action.type === ACTION_LAYER_ADD) {
        return [
            ...state,
            action.payload as ILayer,
        ]
    }

    if (action.type === ACTION_LAYER_SET) {
        return state.map(layer => layer.id !== action.payload.id ? layer : {
            ...layer,
            ...action.payload,
        })
    }

    if (action.type === ACTION_LAYER_DELETE) {
        return state.filter(layer => layer.id !== action.payload.id)
    }

    return state
}

const App: React.FC<IAppProps> = props => {
    const [layerHided, setLayerHided] = React.useState<{ [id: string]: boolean }>({})
    const [featuresIndex, dispatchFeaturesIndex] = React.useReducer<React.Reducer<any, any>>(featuresIndexReducer, props.featureIndex)
    const [userLayers, dispatchLayers] = React.useReducer<React.Reducer<ILayer[], LayerAction>>(layersReducer, props.userLayers)
    const hasLayers = userLayers.length > 0
    const [currentUserLayerId, setCurrentUserLayerId] = React.useState<number>(hasLayers ? userLayers[0].id : null)
    const currentUserLayer = userLayers.find(x => x.id === currentUserLayerId)
    const [mapboxMap, setMapboxMap] = React.useState<mapboxgl.Map>(null)
    const [drawerVisible, setDrawerVisibile] = React.useState(false)
    const [tool, setTool] = React.useState<[string, any]>(null)
    const [checkedCaseKeys, setCheckedCaseKeys] = React.useState(props.defaultCheckedCaseKeys)
    const [layerFilterTree, dispatchLayerFilterTree] = React.useReducer(layerFilterTreeReducer, {})
    const [[activeFeatureLayerId, activeFeatureId], setActive] = React.useState<[number, FeatureId]>([null, null])
    const activeFeature = activeFeatureId ? featuresIndex[activeFeatureId] : null
    const [editLayer, setEditLayer] = React.useState<ILayer>(null)
    const [isAdding, setAdding] = React.useState<boolean>(false)
    const [isFeatureDeleting, setFeatureDeleting] = React.useState<boolean>(false)
    const [isFeatureChangingLayer, setFeatureChangingLayer] = React.useState<boolean>(false)
    const isCurrentTool = (x: string) => Array.isArray(tool)
        ? tool[0] === x
        : false

    const isLayerVisible = (layerId: number) => {
        if (layerId in layerHided) {
            return layerHided[layerId]
        }

        return true
    }

    const isSyncing = isAdding || isFeatureChangingLayer || isFeatureDeleting

    const popupCoord = !activeFeature ? null : ({
        longitude: activeFeature.geometry.coordinates[0],
        latitude: activeFeature.geometry.coordinates[1],
    })

    const selectedFeatureColor = '#1890ff'
    const getPinColor: any = (feature: Feature, color: string, bc: string) => [
        color,
        bc,
        feature === activeFeature
            ? selectedFeatureColor
            : null
    ]

    function createFilter(layer: ILayer): (x: any) => boolean {
        if (layer.schema.filter === 'case-filter') {
            return createFeatureCaseFilter(checkedCaseKeys, true)
        } else if (Array.isArray(layer.schema.filter)) {
            const filterConfig = createFilterConfig(layer.schema)
            const keyMap = filterConfig.treeKeys
            const checkedKeys = getLayerFilterCheckedKeys(layer.id, filterConfig.allTreeKeys)
            const checkedValues = checkedKeys.reduce((values, key) => {
                if (keyMap.has(key)) {
                    const [field, fieldValue] = keyMap.get(key)
                    const value = Array.isArray(values[field]) ? values[field] : []
                    return {
                        ...values,
                        [field]: [...value, fieldValue]
                    }
                }
                return values
            }, {})

            return createFeatureUserFilter(checkedValues)
        } else {
            return () => true
        }
    }

    function getLayerFilterCheckedKeys(layerId: number, defaultValue: string[]): string[] {
        if (layerId in layerFilterTree) {
            return layerFilterTree[layerId]
        }

        return defaultValue
    }

    function createFilterNode(layer: ILayer): () => React.ReactNode {
        if (layer.schema.filter === 'case-filter') {
            return () => (
                <CaseTree
                    disabled={!isLayerVisible(layer.id)}
                    checkedKeys={checkedCaseKeys}
                    onCheck={setCheckedCaseKeys}
                />
            )
        }

        const filterConfig = createFilterConfig(layer.schema)

        if (filterConfig) {
            const checkedKeys = getLayerFilterCheckedKeys(layer.id, filterConfig.allTreeKeys)

            return () => (
                <FeatureFilter
                    disabled={!isLayerVisible(layer.id)}
                    options={filterConfig}
                    checkedKeys={checkedKeys}
                    onCheck={checkedKeys => {
                        dispatchLayerFilterTree({
                            type: ACTION_LAYER_FILTER_TREE_SET_CHECKED_KEYS,
                            payload: {
                                layerId: layer.id,
                                checkedKeys,
                            }
                        })
                    }}
                />
            )
        }

        return null
    }

    const onAddGeojsonFile = React.useCallback(async (points: Feature<Point>[], fileName: string) => {
        setActive([null, null])
        setTool(null)
        setAdding(true)

        const baseName = fileName.replace(/\.(geo)?json$/, '')
        const name = ensureNewLayerNameUnique(baseName)
        const [newFeatures, newLayer] = await uploadGeojsonFeaturesIntoNewLayer<{[name: string]: any}>(points, {
            name,
            color: 'gray',
            readonly: false,
            featureIds: [],
        })

        newFeatures.forEach(f => {
            dispatchFeaturesIndex({
                type: ACTION_FEATURE_SET,
                payload: f,
            })
        })

        dispatchLayers({
            type: ACTION_LAYER_ADD,
            payload: newLayer
        })
        setCurrentUserLayerId(newLayer.id)
        setAdding(false)
    }, [])

    const onDeleteLayerCallback = React.useCallback(async id => {
        await deleteLayer(id)

        dispatchLayers({
            type: ACTION_LAYER_DELETE,
            payload: {
                id,
            },
        })
    }, [])

    const onChangeLayerVisibleCallback = React.useCallback((layer, visible) => {
        setLayerHided({
            ...layerHided,
            [layer.id]: visible,
        })
    }, [layerHided])

    const updateUserFeature = React.useCallback(async (feature: UserFeature) => {
        const updatedFeature = await updateFeature(activeFeature)

        dispatchFeaturesIndex({
            type: ACTION_FEATURE_SET,
            payload: updatedFeature,
        })
    }, [activeFeature]); // The empty array causes this callback to only be created once per component instance

    const ensureNewLayerNameUnique = React.useCallback((name: string) => {
        const names = userLayers.map(x => x.name)
        return makeUnique(name, names)
    }, [userLayers])

    const addNewLayer = React.useCallback(async () => {
        const name = ensureNewLayerNameUnique('New layer')
        const newLayer = await createLayer({
            name,
            color: 'gray',
            readonly: false,
            featureIds: [],
        })

        dispatchLayers({
            type: ACTION_LAYER_ADD,
            payload: newLayer
        })
        setCurrentUserLayerId(newLayer.id)
    }, [])

    const onSubmitLayer = React.useCallback(async (layer: ILayer) => {
        const updatedLayer = await updateLayer(layer)

        dispatchLayers({
            type: ACTION_LAYER_SET,
            payload: updatedLayer,
        })
        setEditLayer(null)
    }, [])

    const onCancelEditLayer = React.useCallback(() => {
        setEditLayer(null)
    }, [])

    const onChangeLayer = React.useCallback(part => {
        setEditLayer({
            ...editLayer,
            ...part,
        })
    }, [editLayer])

    const deleteFeature = React.useCallback(async (featureId: FeatureId, layer: ILayer) => {
        setFeatureDeleting(true)
        const newLayer = await removeFeatureFromLayer(featureId, layer)
        await deleteFeatureId(featureId)

        dispatchFeaturesIndex({
            type: ACTION_FEATURE_DELETE,
            payload: {
                featureId,
            },
        })

        dispatchLayers({
            type: ACTION_LAYER_SET,
            payload: newLayer,
        })

        setFeatureDeleting(false)
    }, [])

    const changeFeatureLayerCallback = React.useCallback(async (featureId: FeatureId, fromLayer: ILayer, toLayer: ILayer) => {
        setFeatureChangingLayer(true)
        const [newFromLayer, newToLayer] = await changeFeatureLayer(featureId, fromLayer, toLayer)

        dispatchLayers({
            type: ACTION_LAYER_SET,
            payload: newFromLayer,
        })
        dispatchLayers({
            type: ACTION_LAYER_SET,
            payload: newToLayer,
        })
        setFeatureChangingLayer(false)
        setActive([newToLayer.id, featureId])
    }, [activeFeature, activeFeatureLayerId])

    const addNewFeatureInLocation = React.useCallback(async (layer: ILayer, latLng: [number, number]) => {
        setActive([null, null])
        setTool(null)
        setAdding(true)

        const [newFeature, newLayer] = await createFeatureInLocationAndAssignToLayer(layer, latLng, {
            // cases: [],
            name: '<new feature>',
        })

        dispatchFeaturesIndex({
            type: ACTION_FEATURE_SET,
            payload: newFeature,
        })
        dispatchLayers({
            type: ACTION_LAYER_SET,
            payload: newLayer,
        })
        setAdding(false)
    }, []); // The empty array causes this callback to only be created once per component instance

    const renderPopup = React.useCallback(() => {
        const activeFeatureLayer = userLayers.find(x => x.id === activeFeatureLayerId)
        const schema = activeFeatureLayer.schema
        const fields = typeof schema.editor === 'string' ? [] : schema.editor

        if (schema.editor === 'json') {
            return (
                <>
                    <Json
                        style={{
                            minWidth: 400,
                            maxWidth: 700,
                        }}
                        data={activeFeature.properties}
                    />
                    <footer style={{
                        display: 'flex',
                    }}>
                        <div style={{
                            flex: 1,
                        }} />

                        {renderPopupActions(activeFeature, activeFeatureLayer)}
                    </footer>
                </>
            )
        } else if (schema.editor === 'case-table') {
            return (
                <FeatureAttributesEditor
                    key={activeFeatureLayerId}
                    feature={activeFeature}
                    renderActions={feature => renderPopupActions(feature, activeFeatureLayer)}
                    onChange={(feature, properties) => {
                        dispatchFeaturesIndex({
                            type: ACTION_FEATURE_SET_PROPERTIES,
                            payload: {
                                featureId: feature.id,
                                properties,
                            }
                        })
                    }}
                />
            )
        }

        return (
            <UserFeatureEditor
                fields={fields}
                feature={activeFeature}
                renderActions={feature => renderPopupActions(feature, activeFeatureLayer)}
                onChange={(feature, key, value) => {
                    dispatchFeaturesIndex({
                        type: ACTION_FEATURE_SET_PROPERTY,
                        payload: {
                            featureId: feature.id,
                            key,
                            value,
                        }
                    })
                }}
            />
        )
    }, [activeFeatureLayerId, userLayers])

    const renderPopupActions = React.useCallback((feature, layer: ILayer) => (
        <>
            <Select
                style={{
                    marginRight: 10,
                }}
                loading={isFeatureChangingLayer}
                disabled={isFeatureChangingLayer}
                defaultValue={activeFeatureLayerId}
                onChange={(selectedLayerId) => {
                    const toLayerId = Number(selectedLayerId)
                    const fromLayer = userLayers.find(x => x.id === activeFeatureLayerId)
                    const toLayer = userLayers.find(x => x.id === toLayerId)

                    changeFeatureLayerCallback(
                        feature.id,
                        fromLayer,
                        toLayer
                    )
                }}
            >
                {userLayers.map(x => (
                    <Select.Option
                        key={x.id}
                        value={x.id}
                    >{x.name}</Select.Option>
                ))}
            </Select>

            <Button
                disabled={isFeatureDeleting}
                loading={isFeatureDeleting}
                onClick={() => {
                    deleteFeature(feature.id, layer)
                }}
            >Delete</Button>
        </>
    ), [userLayers, activeFeature, activeFeatureLayerId, isFeatureChangingLayer, isFeatureDeleting, userLayers])

    return (
        <Container>
            <AppMap
                onLoad={map => {
                    setMapboxMap(map)
                }}
                center={props.center}
                zoom={props.zoom}
                mapStyle={props.mapStyle}
                mapboxToken={props.mapboxToken}
                popup={popupCoord}
                renderPopup={renderPopup}
                onClosePopup={async () => {
                    await updateUserFeature(activeFeature)
                    setActive([null, null])
                }}
                onClickMap={async event => {
                    console.log('click', event.lngLat)
                    const latLng = event.lngLat

                    if (isCurrentTool(ADD_FEATURE_TOOL)) {
                        addNewFeatureInLocation(currentUserLayer, latLng)
                    }
                }}
            >
                {userLayers.map(layer => !isLayerVisible(layer.id) ? null : (
                    <FeatureMarkerLayer<IUserFeatureProperties>
                        key={layer.id}
                        features={selectFeatures(featuresIndex, layer.featureIds, createFilter(layer))}
                        map={mapboxMap}
                        // pinColor={feature => getPinColor(feature, layer.color)}
                        pinColor={feature => {
                            const fn = createMarkerColorFunction(layer.schema, null)
                            const color = fn(feature)
                            return getPinColor(feature, layer.color, color)
                        }}
                        pinText={createPinTextFunction(layer.schema)}
                        onClickFeature={feature => {
                            setActive([layer.id, feature.id])
                        }}
                    />
                ))}
                {/* pinColor={feature => getPinColor(feature, feature.properties.cases.length
                    ? 'tomato'
                    : 'gray')} */}
            </AppMap>

            <AppHeader
                title={'Oymyakon'}
                isSyncing={isSyncing}
                actions={(
                    <>
                        <Upload
                            fileList={null}
                            accept={'geojson'}
                            beforeUpload={file => {
                                return new Promise(resolve => {
                                    const reader = new FileReader()
                                    reader.readAsText(file)
                                    reader.onload = () => {
                                        if (typeof reader.result !== 'string') {
                                            message.error('Cannot open file')
                                            return
                                        }

                                        try {
                                            const geojson = JSON.parse(reader.result)
                                            const points = geojson.features
                                                .filter(feature => feature.geometry.type === 'Point')
                                                .map(feature => omit(feature, 'id', 'properties.id'))

                                            onAddGeojsonFile(points, file.name)
                                        } catch (e) {
                                            message.error('Cannot open file')
                                        }
                                    };

                                    resolve()
                                });

                                // return false;
                            }}
                        >
                            <Button
                                style={{
                                    marginRight: 10,
                                }}
                            >
                                <Icon type="upload" /> Add GeoJSON
                            </Button>
                        </Upload>

                        <ActionButton
                            style={{
                                marginRight: 10,
                            }}
                            icon={'plus'}
                            loading={isAdding}
                            disabled={!hasLayers || isAdding || isCurrentTool(ADD_FEATURE_TOOL)}
                            onClick={() => {
                                setTool([ADD_FEATURE_TOOL, null])
                            }}
                            options={userLayers
                                .filter(x => isLayerVisible(x.id))
                                .map(x => ({
                                    name: x.name,
                                    key: `${x.id}`,
                                }))
                            }
                            optionsTitle={currentUserLayer && currentUserLayer.name}
                            onSelectOption={key => {
                                setCurrentUserLayerId(Number(key))
                            }}
                        />

                        <Button
                            icon={'menu'}

                            onClick={() => {
                                setDrawerVisibile(!drawerVisible)
                            }}
                        />
                    </>
                )}
            />

            <Drawer
                title={'Oymyakon Options'}
                width={'35%'}
                placement={props.drawerPlacement}
                mask={false}
                onClose={() => { setDrawerVisibile(false) }}
                visible={drawerVisible}
                className={'app-drawer'}
            >
                <LayerPanel
                    style={{
                        marginBottom: 15,
                    }}
                    items={userLayers.map(layer => {
                        return {
                            layer,
                            render: createFilterNode(layer),
                            visible: isLayerVisible(layer.id),
                            canHide: layer.id !== currentUserLayerId,
                            info: `${layer.featureIds.length}`,
                        }
                    })}
                    onChangeVisible={onChangeLayerVisibleCallback}
                    onAddLayer={addNewLayer}
                    onClickDownload={async layerId => {
                        await sleep(1000)

                        const layer = userLayers.find(x => x.id === layerId)
                        const features = selectFeatures(featuresIndex, layer.featureIds, createFilter(layer))

                        const content = JSON.stringify(features, null, 4)
                        download(`oymyakon-${layer.name}.geojson`, content)
                    }}
                    onDeleteLayer={onDeleteLayerCallback}
                    onClickLayerEdit={layer => {
                        setEditLayer(layer)
                    }}
                />

                <Select
                    defaultValue={props.mapStyleOption}
                    style={{
                        width: '100%',
                        marginBottom: 15,
                    }}
                    onChange={props.onChangeMapStyleOption}
                >
                    {props.mapStyleOptions.map(x => (
                        <Select.Option
                            key={x.value}
                            value={x.value}
                        >
                            {x.name}
                        </Select.Option>
                    ))}
                </Select>
            </Drawer>

            <EditLayerModal
                layer={editLayer}
                visible={!!editLayer}
                onSubmit={onSubmitLayer}
                onCancel={onCancelEditLayer}
                onChange={onChangeLayer}
            />
        </Container >
    )
}

export default App
