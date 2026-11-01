import { baseEndpoint } from "@/endpoints/base";
import { ITessellateApiRouter } from "@/utils/registry/api/apiRegistry";
import { configDevicev1Endpoint } from "@/endpoints/v1/config/devices";
import { configSettingsv1Endpoint } from "@/endpoints/v1/config/settings";
import { customersv1Endpoint } from "@/endpoints/v1/customers";
import { itemsv1Endpoint } from "@/endpoints/v1/items";
import { locationsv1Endpoint } from "@/endpoints/v1/locations";
import { ordersv1Endpoint } from "@/endpoints/v1/orders";
import { pluginsv1Endpoint } from "@/endpoints/v1/plugins";
import { squarev1Endpoint } from "@/endpoints/v1/square";
import { setupv1Endpoint } from "@/endpoints/v1/setup";
import { authv1Endpoint } from "@/endpoints/v1/auth";
import { authProvidersv1Endpoint } from "@/endpoints/v1/authProviders";

export const routes: ITessellateApiRouter[] = [
    baseEndpoint,
    authv1Endpoint,
    authProvidersv1Endpoint,
    configDevicev1Endpoint,
    configSettingsv1Endpoint,
    customersv1Endpoint,
    itemsv1Endpoint,
    locationsv1Endpoint,
    ordersv1Endpoint,
    pluginsv1Endpoint,
    squarev1Endpoint,
    setupv1Endpoint,
];
