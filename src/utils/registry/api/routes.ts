import { baseEndpoint } from "@/endpoints/base";
import { ITessellateApiRouter } from "./apiRegistry";
import { configDevicev1Endpoint } from "@/endpoints/v1/config/devices"
import { configSettingsv1Endpoint } from "@/endpoints/v1/config/settings"
import { itemsv1Endpoint } from "@/endpoints/v1/items";
import { ordersv1Endpoint } from "@/endpoints/v1/orders";
import { squarev1Endpoint } from "@/endpoints/v1/square";
import { authv1Endpoint } from "@/endpoints/v1/auth";

export const routes: ITessellateApiRouter[] = [
    baseEndpoint,
    authv1Endpoint,
    configDevicev1Endpoint,
    configSettingsv1Endpoint,
    itemsv1Endpoint,
    ordersv1Endpoint,
    squarev1Endpoint
];