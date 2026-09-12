import type { Room } from '../types/admin';
import { hotels } from './hotels';

export const rooms: Room[] = [
  { id: 'rm_1', hotelId: 'h_1', hotelName: hotels[0].name, type: 'Deluxe Ocean View', occupancy: '2 Adults', bedType: 'King', mealPlan: 'Bed & Breakfast', supplier: 'Global Hotel Supply', status: 'active' },
  { id: 'rm_2', hotelId: 'h_1', hotelName: hotels[0].name, type: 'Grand Suite', occupancy: '2 Adults + 2 Children', bedType: 'King', mealPlan: 'All Inclusive', supplier: 'Global Hotel Supply', status: 'active' },
  { id: 'rm_3', hotelId: 'h_2', hotelName: hotels[1].name, type: 'Executive Room', occupancy: '2 Adults', bedType: 'Twin', mealPlan: 'Room Only', supplier: 'Supplier One', status: 'active' },
  { id: 'rm_4', hotelId: 'h_5', hotelName: hotels[4].name, type: 'Standard Double', occupancy: '2 Adults', bedType: 'Queen', mealPlan: 'Bed & Breakfast', supplier: 'Global Hotel Supply', status: 'inactive' },
  { id: 'rm_5', hotelId: 'h_6', hotelName: hotels[5].name, type: 'Loft Room', occupancy: '2 Adults', bedType: 'Double', mealPlan: 'Room Only', supplier: 'Supplier One', status: 'active' },
];
