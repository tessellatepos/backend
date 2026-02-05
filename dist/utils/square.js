"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// import {OrderLineItem, SquareClient, SquareEnvironment} from "square";
//
// const client = new SquareClient({
// 	token: 'EAAAl0q5v4tk-nIOEtTfnEfznIuBoeJ0one76rHJcFKCh14amKh5QyJsYU7MzMyJ',
// 	environment: SquareEnvironment.Production,
// });
//
// export async function fetchItems(): Promise<Map<string>> {
// 	const response = await client.catalog.list();
// 	// const itemsMap = new Map<string, ISquareItem>();
//
// 	// Iterate through the Page results
// 	for await (const item of response) {
// 		// if (item.type === 'ITEM' && item.presentAtLocationIds?.includes("L5913KTSS159H") && item.itemData) {
// 		if (item.type === 'ITEM' && item.presentAtLocationIds?.includes("LRZ8AVN5F5TNN") && item.itemData) {
// 			const imageUrls = item.itemData.imageIds
// 				? await Promise.all(
// 					item.itemData.imageIds.map(async (imageId: string) => {
// 						const imageResponse = await client.catalog.object.get({ objectId: imageId });
// 						const imageObj = imageResponse.object;
// 						// Type guard: check if it's an IMAGE type
// 						if (imageObj?.type === 'IMAGE') {
// 							return imageObj.imageData?.url;
// 						}
// 						return undefined;
// 					})
// 				)
// 				: [];
//
// 			// Get price from first variation
// 			let price = 0;
// 			const firstVariation = item.itemData.variations?.[0];
// 			if (firstVariation?.type === 'ITEM_VARIATION') {
// 				const priceAmount = firstVariation.itemVariationData?.priceMoney?.amount;
// 				price = priceAmount ? Number(priceAmount) : 0;
// 			}
//
// 	// 		const catalogItem: ISquareItem = {
// 	// 			uid: item.id,
// 	// 			name: item.itemData.name ?? '',
// 	// 			price: price,
// 	// 			imageURL: imageUrls.filter(url => url).join(', '),
// 	// 		};
//     //
// 	// 		itemsMap.set(item.id, catalogItem);
// 	// 	}
// 	// }
//     //
// 	// return itemsMap;
// }
//
// function convertToOrderLineItem(cartItem: ISquareCartItem[]): OrderLineItem[] {
//     return cartItem.map((cartItem) => ({
//         name: cartItem.name,
//         quantity: cartItem.quantity?.toString() || '1',
//         basePriceMoney: {
//             amount: BigInt(cartItem.price || 0),
//             currency: 'USD'
//         },
//         catalogObjectId: cartItem.uid
//     }));
// }
//
// export async function createPreviewOrder(cart: ISquareCartItem[]): Promise<string | undefined> {
//     const order = convertToOrderLineItem(cart)
//         const response = await client.orders.calculate({
//             // idempotencyKey: crypto.randomUUID(),
//             order: {
//                 locationId: 'LRZ8AVN5F5TNN',
//                 lineItems: order
//             }
//         });
//         return response.order?.totalMoney?.amount?.toString()
// }
