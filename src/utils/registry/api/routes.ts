import { baseEndpoint } from "@/endpoints/base";
import { ITessellateApiRouter } from "@/utils/registry/api/apiRegistry";
import { catalogv1Endpoint } from "@/endpoints/v1/catalog";
import { configDevicev1Endpoint } from "@/endpoints/v1/config/devices";
import { configSettingsv1Endpoint } from "@/endpoints/v1/config/settings";
import { configProviderv1Endpoint } from "@/endpoints/v1/config/provider";
import { configStorefrontsv1Endpoint } from "@/endpoints/v1/config/storefronts";
import { dashboardv1Endpoint } from "@/endpoints/v1/dashboard";
import { credentialsv1Endpoint } from "@/endpoints/v1/credentials";
import { gatewayRouter } from "@/gateway/router";
import { customersv1Endpoint } from "@/endpoints/v1/customers";
import { itemsv1Endpoint } from "@/endpoints/v1/items";
import { locationsv1Endpoint } from "@/endpoints/v1/locations";
import { ordersv1Endpoint } from "@/endpoints/v1/orders";
import { paymentsv1Endpoint } from "@/endpoints/v1/payments";
import { pluginsv1Endpoint } from "@/endpoints/v1/plugins";
import { squarev1Endpoint } from "@/endpoints/v1/square";
import { setupv1Endpoint } from "@/endpoints/v1/setup";
import { authv1Endpoint } from "@/endpoints/v1/auth";
import { usersv1Endpoint } from "@/endpoints/v1/users";
import { authProvidersv1Endpoint } from "@/endpoints/v1/authProviders";

export const routes: ITessellateApiRouter[] = [
    baseEndpoint,
    // The gateway is generated from the other routers; see mountApiRoutes.
    {
        route_path: "/gateway/v1",
        version: "v1",
        override_default: true,
        router: gatewayRouter,
    },
    authv1Endpoint,
    authProvidersv1Endpoint,
    catalogv1Endpoint,
    configDevicev1Endpoint,
    configSettingsv1Endpoint,
    configProviderv1Endpoint,
    configStorefrontsv1Endpoint,
    credentialsv1Endpoint,
    customersv1Endpoint,
    dashboardv1Endpoint,
    itemsv1Endpoint,
    locationsv1Endpoint,
    ordersv1Endpoint,
    paymentsv1Endpoint,
    pluginsv1Endpoint,
    squarev1Endpoint,
    setupv1Endpoint,
    usersv1Endpoint,
];
